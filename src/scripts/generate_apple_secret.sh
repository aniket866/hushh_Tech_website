#!/bin/bash

# ==========================================
# 🍎 Apple Client Secret Generator (FIXED)
# ==========================================

read_env_var() {
    local key="$1"
    local file
    for file in .env.local .env; do
        if [ -f "$file" ]; then
            awk -F '=' -v search_key="$key" '
                $0 ~ "^[[:space:]]*" search_key "[[:space:]]*=" {
                    value = substr($0, index($0, "=") + 1)
                    gsub(/^[[:space:]]+|[[:space:]]+$/, "", value)
                    gsub(/^"|"$/, "", value)
                    print value
                    exit
                }
            ' "$file"
        fi
    done
}

# --- 1. CONFIGURATION (ENTER YOUR DETAILS HERE) ---
# Values are read from exported env vars first, then .env.local, then .env.
TEAM_ID="${APPLE_TEAM_ID:-$(read_env_var APPLE_TEAM_ID)}"
KEY_ID="${APPLE_KEY_ID:-$(read_env_var APPLE_KEY_ID)}"
CLIENT_ID="${APPLE_CLIENT_ID:-$(read_env_var APPLE_CLIENT_ID)}"
KEY_FILE_PATH="${APPLE_KEY_FILE_PATH:-${APPLE_PRIVATE_KEY_PATH:-$(read_env_var APPLE_KEY_FILE_PATH)}}"

if [ -z "$TEAM_ID" ] || [ -z "$KEY_ID" ] || [ -z "$CLIENT_ID" ]; then
    echo "❌ Error: Missing APPLE_TEAM_ID, APPLE_KEY_ID, or APPLE_CLIENT_ID."
    echo "   Set them in your shell, .env.local, or .env."
    exit 1
fi

if [ -z "$KEY_FILE_PATH" ]; then
    KEY_FILE_PATH="$HOME/.private_keys/AuthKey_${KEY_ID}.p8"
fi

# --- 2. SETUP & GENERATION ---

# Check if Node is installed
if ! command -v node &> /dev/null; then
    echo "❌ Error: Node.js is not installed."
    exit 1
fi

# Check if .p8 file exists
if [ ! -f "$KEY_FILE_PATH" ]; then
    echo "❌ Error: Key file not found at $KEY_FILE_PATH"
    echo "   Set APPLE_KEY_FILE_PATH or APPLE_PRIVATE_KEY_PATH, or place AuthKey_${KEY_ID}.p8 in ~/.private_keys/"
    exit 1
fi

KEY_FILENAME="$(basename "$KEY_FILE_PATH")"
if [[ "$KEY_FILENAME" =~ ^AuthKey_([A-Z0-9]+)\.p8$ ]]; then
    FILE_KEY_ID="${BASH_REMATCH[1]}"
    if [ "$FILE_KEY_ID" != "$KEY_ID" ]; then
        echo "❌ Error: KEY_ID ($KEY_ID) does not match key file name ($KEY_FILENAME)"
        echo "   Update KEY_ID or point KEY_FILE_PATH to the matching AuthKey_<KEY_ID>.p8 file."
        exit 1
    fi
fi

echo "⚙️  Setting up temporary environment..."
mkdir -p temp_apple_gen
cd temp_apple_gen

# Initialize dummy package to install jsonwebtoken quietly
npm init -y > /dev/null
echo "📦 Installing 'jsonwebtoken' library..."
npm install jsonwebtoken --silent

# Create the Node.js generator script
# NOTICE: We are now correctly using the variables ($KEY_FILE_PATH, etc)
cat <<EOF > generate.js
const fs = require('fs');
const jwt = require('jsonwebtoken');

// Read the key file from the parent directory
// We use the variable passed from Bash
const privateKey = fs.readFileSync('../$KEY_FILE_PATH');

const token = jwt.sign({}, privateKey, {
  algorithm: 'ES256',
  expiresIn: '180d',
  issuer: '$TEAM_ID',
  audience: 'https://appleid.apple.com',
  subject: '$CLIENT_ID',
  keyid: '$KEY_ID'
});

console.log(token);
EOF

# --- 3. EXECUTION ---
echo "🔐 Generating Client Secret..."
SECRET=$(node generate.js)

# --- 4. CLEANUP ---
cd ..
rm -rf temp_apple_gen

# --- 5. RESULT ---
echo ""
echo "✅ SUCCESS! Here is your Client Secret (valid for 6 months):"
echo ""
echo "$SECRET"
echo ""
echo "👉 Copy the string above and paste it into your GcpBackend/Auth provider settings."
