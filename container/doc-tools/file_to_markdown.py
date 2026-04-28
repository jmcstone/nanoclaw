#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import mimetypes
import sys
import traceback
from pathlib import Path
from typing import Callable, Literal

ConverterName = Literal['markitdown', 'docling']

MARKITDOWN_SUFFIXES = {
    '.doc',
    '.docx',
    '.xls',
    '.xlsx',
    '.ppt',
    '.pptx',
    '.pdf',
    '.html',
    '.htm',
    '.csv',
    '.json',
    '.xml',
    '.txt',
    '.md',
    '.rtf',
    '.epub',
}

DOCLING_SUFFIXES = {
    '.pdf',
    '.png',
    '.jpg',
    '.jpeg',
    '.tif',
    '.tiff',
    '.bmp',
    '.webp',
    '.gif',
    '.docx',
    '.pptx',
    '.xlsx',
    '.html',
    '.htm',
}


def choose_converters(path: Path, preferred: str) -> list[ConverterName]:
    if preferred in {'markitdown', 'docling'}:
        return [preferred]  # type: ignore[list-item]

    suffix = path.suffix.lower()
    if suffix in MARKITDOWN_SUFFIXES:
        return ['markitdown', 'docling']
    if suffix in DOCLING_SUFFIXES:
        return ['docling', 'markitdown']
    return ['markitdown', 'docling']


def convert_with_markitdown(path: Path) -> tuple[str, dict]:
    from markitdown import MarkItDown

    result = MarkItDown(enable_plugins=False).convert(str(path))
    markdown = getattr(result, 'text_content', None)
    if markdown is None:
        raise RuntimeError('MarkItDown returned no text_content')
    meta = {
        'converter_result_type': type(result).__name__,
    }
    return markdown, meta


def convert_with_docling(path: Path) -> tuple[str, dict]:
    os.environ['HF_HOME'] = '/home/node/.cache/huggingface'
    os.environ['HUGGINGFACE_HUB_CACHE'] = '/home/node/.cache/huggingface/hub'

    from docling.datamodel.base_models import InputFormat
    from docling.datamodel.pipeline_options import PdfPipelineOptions
    from docling.document_converter import DocumentConverter, PdfFormatOption

    if path.suffix.lower() == '.pdf':
        converter = DocumentConverter(
            format_options={
                InputFormat.PDF: PdfFormatOption(
                    pipeline_options=PdfPipelineOptions(
                        do_ocr=False,
                        force_backend_text=True,
                    )
                )
            }
        )
    else:
        converter = DocumentConverter()

    result = converter.convert(str(path))
    markdown = result.document.export_to_markdown()
    meta = {
        'pages': getattr(getattr(result, 'input', None), 'page_count', None),
    }
    return markdown, meta


def main() -> int:
    parser = argparse.ArgumentParser(
        description='Convert a local file to Markdown using MarkItDown or Docling.',
    )
    parser.add_argument('path', help='Path to a local file inside the container workspace')
    parser.add_argument(
        '--converter',
        choices=['auto', 'markitdown', 'docling'],
        default='auto',
    )
    parser.add_argument('--pretty', action='store_true', help='Pretty-print JSON output')
    args = parser.parse_args()

    path = Path(args.path).expanduser().resolve()
    if not path.exists() or not path.is_file():
        print(json.dumps({'error': f'File not found: {path}'}), file=sys.stderr)
        return 2

    warnings: list[str] = []
    mime_type, _ = mimetypes.guess_type(str(path))

    dispatch: dict[ConverterName, Callable[[Path], tuple[str, dict]]] = {
        'markitdown': convert_with_markitdown,
        'docling': convert_with_docling,
    }

    last_error: BaseException | None = None
    last_trace: str | None = None
    for converter in choose_converters(path, args.converter):
        try:
            markdown, meta = dispatch[converter](path)
            payload = {
                'converter': converter,
                'path': str(path),
                'mime_type': mime_type,
                'markdown': markdown,
                'warnings': warnings,
                'meta': meta,
            }
            print(json.dumps(payload, indent=2 if args.pretty else None, ensure_ascii=False))
            return 0
        except Exception as exc:  # noqa: BLE001
            last_error = exc
            last_trace = traceback.format_exc()
            warnings.append(f'{converter} failed: {exc}')

    error_payload = {
        'error': f'Unable to convert {path.name} to markdown',
        'path': str(path),
        'mime_type': mime_type,
        'warnings': warnings,
        'last_error': str(last_error) if last_error else None,
        'traceback': last_trace,
    }
    print(json.dumps(error_payload, ensure_ascii=False), file=sys.stderr)
    return 1


if __name__ == '__main__':
    raise SystemExit(main())
