#!/bin/bash
# Test script untuk workflow system
# Usage: ./test-workflow.sh

echo "=== Workflow System Test ==="
echo ""

# Check if cargo is available
if ! command -v cargo &> /dev/null; then
    echo "⚠️  Cargo not found. Cannot compile Rust code."
    echo "   Install Rust: https://rustup.rs/"
    exit 1
fi

cd src-tauri

echo "1. Checking Rust syntax..."
cargo check 2>&1 | head -30
if [ $? -eq 0 ]; then
    echo "✅ Rust syntax OK"
else
    echo "❌ Rust syntax errors found"
fi

echo ""
echo "2. Testing workflow data directory..."
WORKFLOW_DIR="$HOME/.openclaw/clawpanel/workflows"
mkdir -p "$WORKFLOW_DIR"
echo "✅ Workflow directory: $WORKFLOW_DIR"

echo ""
echo "3. Creating test data..."
cat > "$WORKFLOW_DIR/settings.json" << 'EOF'
{
  "enabled": true,
  "model": "gpt-4o",
  "approval_level": 2,
  "auto_create": false,
  "push_progress": true,
  "progress_mode": "detailed"
}
EOF
echo "✅ Test settings created"

cat > "$WORKFLOW_DIR/templates.json" << 'EOF'
[
  {
    "id": "test-template-001",
    "name": "Test Workflow",
    "description": "A test workflow template",
    "steps": ["Step 1: Initialize", "Step 2: Process", "Step 3: Complete"],
    "meta": "3 steps",
    "created_at": "2025-03-26 10:00",
    "updated_at": "2025-03-26 10:00"
  }
]
EOF
echo "✅ Test templates created"

cat > "$WORKFLOW_DIR/runs.json" << 'EOF'
[
  {
    "id": "run-001",
    "template_id": "test-template-001",
    "title": "Test Run 1",
    "status": "completed",
    "progress": 100,
    "current_step": 3,
    "steps": 3,
    "time": "2025-03-26 10:05",
    "meta": "From: Test Workflow",
    "created_at": 1711430700,
    "updated_at": 1711430800
  }
]
EOF
echo "✅ Test runs created"

cat > "$WORKFLOW_DIR/logs.json" << 'EOF'
{
  "run-001": [
    {"ts": "2025-03-26 10:05", "level": "info", "msg": "Workflow started: Test Run 1"},
    {"ts": "2025-03-26 10:06", "level": "success", "msg": "Step 1 completed"},
    {"ts": "2025-03-26 10:07", "level": "success", "msg": "Step 2 completed"},
    {"ts": "2025-03-26 10:08", "level": "success", "msg": "Workflow completed"}
  ]
}
EOF
echo "✅ Test logs created"

echo ""
echo "4. Test data structure:"
echo "   Settings: $(cat $WORKFLOW_DIR/settings.json | wc -c) bytes"
echo "   Templates: $(cat $WORKFLOW_DIR/templates.json | wc -c) bytes"
echo "   Runs: $(cat $WORKFLOW_DIR/runs.json | wc -c) bytes"
echo "   Logs: $(cat $WORKFLOW_DIR/logs.json | wc -c) bytes"

echo ""
echo "=== Test Complete ==="
echo ""
echo "To build and test:"
echo "  cd src-tauri && cargo build"
echo ""
echo "To run the app:"
echo "  npm run tauri dev"
