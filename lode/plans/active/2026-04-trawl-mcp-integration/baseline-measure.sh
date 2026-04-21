#!/bin/bash
# Baseline measurement harness for the Trawl MCP integration plan.
#
# Captures metrics from a Claude Agent SDK session JSONL (main + subagents)
# for pre-Trawl and post-Trawl comparison. Run this before activating Trawl
# on a group, then again after, to quantify the impact.
#
# Usage:
#   baseline-measure.sh <session-dir>
#
# session-dir is the directory containing:
#   <session-id>.jsonl
#   <session-id>/subagents/*.jsonl
#
# Example:
#   baseline-measure.sh ~/containers/data/NanoClaw/data/sessions/telegram_avp/.claude/projects/-workspace-group

set -euo pipefail

SESSDIR="${1:-}"
if [[ -z "$SESSDIR" || ! -d "$SESSDIR" ]]; then
    echo "Usage: $0 <session-dir>" >&2
    exit 1
fi

# Find the newest session jsonl in the dir
MAIN=$(ls -t "$SESSDIR"/*.jsonl 2>/dev/null | head -1)
if [[ -z "$MAIN" ]]; then
    echo "No session JSONL found in $SESSDIR" >&2
    exit 1
fi
SESSID=$(basename "$MAIN" .jsonl)
SUBDIR="$SESSDIR/$SESSID/subagents"

tool_counts() {
    local file="$1"
    jq -r 'select(.type=="assistant") | .message.content[]? | select(.type=="tool_use") | .name' "$file" 2>/dev/null | sort | uniq -c | sort -rn
}

cat <<EOF
=== Session baseline: $SESSID ===
Source: $MAIN

--- Main session ---
Size: $(du -h "$MAIN" | awk '{print $1}')
Lines: $(wc -l < "$MAIN")

Tool calls:
$(tool_counts "$MAIN" | sed 's/^/  /')

--- Subagents ---
EOF

if [[ -d "$SUBDIR" ]]; then
    N=$(ls "$SUBDIR"/*.jsonl 2>/dev/null | wc -l)
    TOTAL=$(du -cb "$SUBDIR"/*.jsonl 2>/dev/null | tail -1 | awk '{print $1}')
    AVG=$(( TOTAL / N ))
    echo "Count: $N"
    echo "Total size: $(numfmt --to=iec $TOTAL)"
    echo "Average size: $(numfmt --to=iec $AVG)"
    echo ""
    echo "Aggregated tool calls:"
    cat "$SUBDIR"/*.jsonl 2>/dev/null | jq -r 'select(.type=="assistant") | .message.content[]? | select(.type=="tool_use") | .name' 2>/dev/null | sort | uniq -c | sort -rn | sed 's/^/  /'
else
    echo "(none)"
fi

echo ""
echo "--- Web-specific metrics ---"
WS_MAIN=$(jq -r 'select(.type=="assistant") | .message.content[]? | select(.type=="tool_use" and .name=="WebSearch") | .input.query' "$MAIN" 2>/dev/null | wc -l)
WF_MAIN=$(jq -r 'select(.type=="assistant") | .message.content[]? | select(.type=="tool_use" and .name=="WebFetch") | .input.url' "$MAIN" 2>/dev/null | wc -l)
WS_SUB=0
WF_SUB=0
UNIQUE_URLS=0
if [[ -d "$SUBDIR" ]]; then
    WS_SUB=$(cat "$SUBDIR"/*.jsonl 2>/dev/null | jq -r 'select(.type=="assistant") | .message.content[]? | select(.type=="tool_use" and .name=="WebSearch") | .input.query' 2>/dev/null | wc -l)
    WF_SUB=$(cat "$SUBDIR"/*.jsonl 2>/dev/null | jq -r 'select(.type=="assistant") | .message.content[]? | select(.type=="tool_use" and .name=="WebFetch") | .input.url' 2>/dev/null | wc -l)
    UNIQUE_URLS=$(cat "$SUBDIR"/*.jsonl 2>/dev/null | jq -r 'select(.type=="assistant") | .message.content[]? | select(.type=="tool_use" and .name=="WebFetch") | .input.url' 2>/dev/null | sort -u | wc -l)
fi

echo "WebSearch (main):   $WS_MAIN"
echo "WebSearch (subs):   $WS_SUB"
echo "WebFetch  (main):   $WF_MAIN"
echo "WebFetch  (subs):   $WF_SUB"
echo "Unique URLs fetched: $UNIQUE_URLS / $((WF_MAIN + WF_SUB)) total (dedup opportunity)"

echo ""
echo "--- Rationale ---"
echo "Use this output to compare against post-Trawl measurements."
echo "Expected improvements after Trawl activation:"
echo "  * Lower WebSearch/WebFetch counts in Madison's transcript (moved to Trawl)"
echo "  * Smaller avg subagent size (contract + Trawl delegation reduces verbosity)"
echo "  * Higher unique-URL ratio (Trawl's cache dedups across sub-invocations)"
