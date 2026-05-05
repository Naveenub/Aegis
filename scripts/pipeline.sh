#!/bin/bash

echo "Running pipeline..."

node cli/claude.js "Analyze codebase"
npm test || exit 1

echo "Done"
