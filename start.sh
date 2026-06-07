#!/bin/bash
echo ""
echo "╔══════════════════════════════════════════╗"
echo "║      SOA TRADER — Starting up...         ║"
echo "╚══════════════════════════════════════════╝"
echo ""

# Check Node.js
if ! command -v node &> /dev/null; then
    echo "ERROR: Node.js not found!"
    echo "Install from: https://nodejs.org"
    exit 1
fi

# Install deps if needed
if [ ! -d "node_modules" ]; then
    echo "Installing dependencies..."
    npm install
fi

echo "Starting SOA Trader server..."
echo "Open Chrome → http://localhost:3000"
echo ""
echo "To install as PWA on Android:"
echo "  1. Open Chrome on phone"
echo "  2. Go to http://YOUR_PC_IP:3000"
echo "  3. Tap menu → Add to Home Screen"
echo ""
node server.js
