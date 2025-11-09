# 📦 NPM Package MCP Server

[![npm version](https://badge.fury.io/js/npm-package-mcp-server.svg)](https://badge.fury.io/js/npm-package-mcp-server)
[![TypeScript](https://img.shields.io/badge/TypeScript-007ACC?style=flat&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen)](https://nodejs.org/)

> A powerful Model Context Protocol (MCP) server that enables AI assistants to fetch, explore, and analyze source code from any NPM package in real-time.

## 🚀 Quick Start

```bash
# Install
npm install -g npm-package-mcp-server

# Run
npm-package-mcp-server
```

## ✨ Features

- 📦 **Fetch Any NPM Package**: Download and explore source code from millions of packages
- 🔍 **Smart File Discovery**: List and filter files with intelligent code detection
- 📄 **Selective Code Reading**: Get specific files or entire codebases
- 🏷️ **Version Control**: Support for any published package version
- 🧹 **Auto Cleanup**: Automatic temporary file management
- 🔒 **Type Safe**: Full TypeScript support with comprehensive error handling
- ⚡ **ES Modules**: Modern JavaScript with optimal performance
- 🤖 **AI-Ready**: Perfect integration with Claude, ChatGPT, and other AI assistants

## 🎯 Use Cases

- **Code Analysis**: Analyze libraries before adopting them
- **Learning**: Study well-written open source code
- **AI Development**: Enable AI assistants to understand package internals
- **Documentation**: Generate docs by analyzing source code
- **Security Auditing**: Review dependencies for security issues
- **Migration Planning**: Understand APIs when upgrading packages

## 📖 API Reference

### Tools Available

#### `get_npm_package_code`
```typescript

## 🔧 Installation & Setup

### Option 1: Global Installation
```bash
npm install -g npm-package-mcp-server
npm-package-mcp-server
```

### Option 2: Local Development
```bash
git clone https://github.com/Ligament/npm-package-mcp-server.git
cd npm-package-mcp-server
npm install
npm run build
npm start
```

### Option 3: Docker (Production)

```bash
# Build Docker image
docker build -t npm-package-mcp-server .

# Run in stdio mode (Claude Desktop)
docker run -it npm-package-mcp-server

# Run in HTTP mode with authentication
docker run -p 3000:3000 \
  -e TRANSPORT_MODE=http \
  -e AUTH_TOKEN=your-secret-key \
  npm-package-mcp-server

# Or use Docker Compose
docker-compose up -d
```

## 📊 Supported Packages

- ✅ All public NPM packages
- ✅ Scoped packages (`@org/package`)
- ✅ Any published version
- ✅ TypeScript and JavaScript
- ✅ React, Vue, Angular, Node.js packages
- ✅ Monorepo packages

## 🔥 Popular Packages to Explore

Try these commands with your AI assistant:

```
"Analyze the lodash utility functions"
"Show me the React hooks implementation"
"Explore the Express.js middleware system"
"Review the TypeScript compiler source"
```

## 🤝 Related Projects

- [Model Context Protocol](https://github.com/modelcontextprotocol/servers)
- [Claude Desktop](https://claude.ai/desktop)
- [NPM Registry API](https://github.com/npm/registry)

## 🙏 Credits

This project is a fork of [Ligament/npm-package-mcp-server](https://github.com/Ligament/npm-package-mcp-server) - thanks for the original implementation!

Enhanced with:
- ✅ Production-ready container setup
- ✅ Bearer token authentication
- ✅ OWASP MCP Top 10 compliance
- ✅ Modern TypeScript (v5) with strict mode
- ✅ Zero vulnerabilities