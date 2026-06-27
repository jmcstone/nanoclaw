#!/usr/bin/env node
/**
 * Fetch a single Protonmail email by UID via IMAP (Protonmail Bridge).
 * Usage: node fetch-protonmail.js <uid> <address>
 *
 * Reads bridge config from /home/node/.protonmail-bridge/config.json
 * and password from PROTONMAIL_BRIDGE_PASSWORD env var or the config.
 *
 * Outputs the plain-text body to stdout.
 */

import { createConnection } from 'net';
import { readFileSync } from 'fs';

const [uid, address] = process.argv.slice(2);
if (!uid || !address) {
  console.error('Usage: node fetch-protonmail.js <uid> <address>');
  process.exit(1);
}

let config;
try {
  config = JSON.parse(
    readFileSync('/home/node/.protonmail-bridge/config.json', 'utf-8'),
  );
} catch {
  console.error('Cannot read Protonmail bridge config');
  process.exit(1);
}

const host = config.host === 'host.docker.internal' ? 'host.docker.internal' : config.host;
const port = config.imapPort;
const password = config.password || process.env.PROTONMAIL_BRIDGE_PASSWORD;

if (!password) {
  console.error('No password found in config or PROTONMAIL_BRIDGE_PASSWORD env');
  process.exit(1);
}

// Minimal IMAP client — just enough to LOGIN, SELECT, FETCH, LOGOUT
function imapFetch() {
  return new Promise((resolve, reject) => {
    const sock = createConnection({ host, port }, () => {});
    let buffer = '';
    let tagCounter = 1;
    let state = 'greeting';
    let fetchBody = '';
    let literalBytes = 0;
    let collectingLiteral = false;

    const tag = () => `A${tagCounter++}`;
    const send = (cmd) => {
      const t = tag();
      sock.write(`${t} ${cmd}\r\n`);
      return t;
    };

    sock.setEncoding('utf-8');
    sock.setTimeout(30000);

    sock.on('timeout', () => {
      reject(new Error('IMAP connection timed out'));
      sock.destroy();
    });

    sock.on('error', reject);

    sock.on('data', (chunk) => {
      buffer += chunk;

      // Handle literal data collection
      if (collectingLiteral) {
        if (buffer.length >= literalBytes) {
          fetchBody += buffer.slice(0, literalBytes);
          buffer = buffer.slice(literalBytes);
          collectingLiteral = false;
          // Continue processing remaining buffer
        } else {
          return; // Wait for more data
        }
      }

      // Process complete lines
      const lines = buffer.split('\r\n');
      buffer = lines.pop() || ''; // Keep incomplete line in buffer

      for (const line of lines) {
        if (state === 'greeting' && line.startsWith('* OK')) {
          state = 'login';
          send(`LOGIN "${address}" "${password}"`);
        } else if (state === 'login' && line.match(/^A\d+ OK/)) {
          state = 'select';
          send('SELECT INBOX');
        } else if (state === 'select' && line.match(/^A\d+ OK/)) {
          state = 'fetch';
          send(`UID FETCH ${uid} BODY[TEXT]`);
        } else if (state === 'fetch') {
          // Check for literal marker: * N FETCH ... {size}
          const literalMatch = line.match(/\{(\d+)\}$/);
          if (literalMatch) {
            literalBytes = parseInt(literalMatch[1], 10);
            collectingLiteral = true;
            // Any remaining buffer content is part of the literal
            if (buffer.length >= literalBytes) {
              fetchBody += buffer.slice(0, literalBytes);
              buffer = buffer.slice(literalBytes);
              collectingLiteral = false;
            }
            return;
          }
          if (line.match(/^A\d+ OK/)) {
            state = 'logout';
            send('LOGOUT');
          } else if (line.match(/^A\d+ (NO|BAD)/)) {
            reject(new Error(`IMAP FETCH failed: ${line}`));
            sock.destroy();
            return;
          }
        } else if (state === 'logout') {
          resolve(fetchBody);
          sock.destroy();
          return;
        }
      }
    });

    sock.on('close', () => {
      if (state !== 'logout') {
        resolve(fetchBody || '');
      }
    });
  });
}

try {
  const body = await imapFetch();

  // Try to extract text/plain from MIME body
  const text = extractTextPlain(body);
  console.log(text || body);
} catch (err) {
  console.error(`Error: ${err.message}`);
  process.exit(1);
}

/**
 * Extract text/plain from a MIME body part (may be multipart).
 */
function extractTextPlain(raw) {
  if (!raw || typeof raw !== 'string') return '';

  // Check if it's multipart
  const boundaryMatch = raw.match(/boundary="?([^"\r\n;]+)"?/i);
  if (boundaryMatch) {
    const boundary = boundaryMatch[1];
    const parts = raw.split(`--${boundary}`);

    // First pass: direct text/plain
    for (const part of parts) {
      const headerEnd = part.indexOf('\r\n\r\n');
      if (headerEnd === -1) continue;
      const headers = part.slice(0, headerEnd).toLowerCase();
      if (!headers.includes('text/plain')) continue;

      let body = part.slice(headerEnd + 4).trim();
      const endBound = body.indexOf(`--${boundary}`);
      if (endBound !== -1) body = body.slice(0, endBound).trim();

      if (headers.includes('quoted-printable')) {
        body = body
          .replace(/=\r?\n/g, '')
          .replace(/=([0-9A-Fa-f]{2})/g, (_, h) =>
            String.fromCharCode(parseInt(h, 16)),
          );
      }
      if (headers.includes('base64')) {
        body = Buffer.from(body.replace(/\s/g, ''), 'base64').toString('utf-8');
      }
      return body;
    }

    // Second pass: recurse into nested multipart
    for (const part of parts) {
      const headerEnd = part.indexOf('\r\n\r\n');
      if (headerEnd === -1) continue;
      const headers = part.slice(0, headerEnd).toLowerCase();
      if (!headers.includes('multipart/')) continue;
      const result = extractTextPlain(part.trim());
      if (result) return result;
    }
  }

  // Not multipart — decode and return as-is
  let body = raw;
  if (/quoted-printable/i.test(raw.slice(0, 500))) {
    body = body
      .replace(/=\r?\n/g, '')
      .replace(/=([0-9A-Fa-f]{2})/g, (_, h) =>
        String.fromCharCode(parseInt(h, 16)),
      );
  }
  return body;
}
