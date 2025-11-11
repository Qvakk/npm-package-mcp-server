#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  ErrorCode,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import https from 'https';
import { createServer, IncomingMessage, ServerResponse } from 'http';
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import * as tar from 'tar';
import { fileURLToPath } from 'url';
import { z } from 'zod';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Types
type ToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
};

type ResourceResult = {
  contents: Array<{
    uri: string;
    mimeType: string;
    text: string;
  }>;
};

interface PackageInfo {
  name: string;
  version: string;
  dist: { tarball: string; shasum: string };
  description?: string;
  main?: string;
  types?: string;
  keywords?: string[];
  author?: string | { name: string; email?: string };
  license?: string;
  homepage?: string;
  repository?: { type: string; url: string };
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

interface SearchResult {
  name: string;
  version: string;
  description?: string;
  keywords?: string[];
  author?: string | { name: string; email?: string };
  date: string;
  links: { npm: string; homepage?: string; repository?: string };
  publisher: { username: string; email?: string };
  maintainers: Array<{ username: string; email?: string }>;
  score: {
    final: number;
    detail: { quality: number; popularity: number; maintenance: number };
  };
}

interface SearchResponse {
  objects: Array<{
    package: SearchResult;
    score: {
      final: number;
      detail: { quality: number; popularity: number; maintenance: number };
    };
  }>;
  total: number;
  time: string;
}

interface CodeFile {
  path: string;
  content: string;
}

interface GetPackageCodeArgs {
  packageName: string;
  version?: string | undefined;
  filePath?: string | undefined;
}

interface ListPackageFilesArgs {
  packageName: string;
  version?: string | undefined;
}

interface SearchPackagesArgs {
  query: string;
  size?: number | undefined;
  from?: number | undefined;
}

// Constants
const CODE_EXTENSIONS = ['.js', '.ts', '.jsx', '.tsx', '.mjs', '.cjs', '.json'];
const SKIP_DIRECTORIES = ['.git', '.svn', '.hg', 'node_modules', '.DS_Store', '__pycache__'];
const CACHE_DURATION = 24 * 60 * 60 * 1000; // 24 hours
const MAX_CODE_FILES = 20; // Limit responses to prevent overwhelming

class NpmPackageServer {
  private server: McpServer;
  private readonly tempDir: string;
  private readonly authToken: string | null;
  private popularPackagesCache: string | null = null;
  private popularPackagesCacheTime: number = 0;

  constructor() {
    this.tempDir = path.join(__dirname, 'temp');
    this.authToken = process.env.AUTH_TOKEN || null;
    this.server = new McpServer(
      { name: 'npm-package-server', version: '1.0.0' }
    );

    this.registerTools();
    this.registerResources();
    this.ensureTempDir();
  }

  private ensureTempDir(): void {
    if (!fs.existsSync(this.tempDir)) {
      fs.mkdirSync(this.tempDir, { recursive: true });
    }
  }

  private isAuthValid(authHeader: string | undefined): boolean {
    if (!this.authToken) {
      return true; // No token required if AUTH_TOKEN not set
    }

    if (!authHeader) {
      return false;
    }

    // Support both "Bearer TOKEN" and "TOKEN" formats
    const token = authHeader.startsWith('Bearer ') 
      ? authHeader.slice(7) 
      : authHeader;

    return token === this.authToken;
  }

  private registerResources(): void {
    this.server.registerResource(
      'popular-packages',
      'npm://popular-packages',
      {
        title: 'Popular NPM Packages',
        description: 'List of the 50 most popular npm packages with details',
        mimeType: 'application/json',
      },
      async () => await this.getPopularPackages()
    );
  }

  private registerTools(): void {
    // Tool 1: Get NPM Package Code
    this.server.registerTool(
      'get_npm_package_code',
      {
        title: 'Get NPM Package Code',
        description: 'Fetch source code from an npm package',
        inputSchema: {
          packageName: z.string().describe('The name of the npm package (e.g., "lodash" or "@babel/core")'),
          version: z.string().optional().describe('Specific version to fetch (optional, defaults to latest)'),
          filePath: z.string().optional().describe('Specific file path within the package (optional, returns all files if not specified)'),
        },
      },
      async ({ packageName, version, filePath }) => {
        const args: GetPackageCodeArgs = {
          packageName,
          ...(version !== undefined && { version }),
          ...(filePath !== undefined && { filePath }),
        };
        return await this.getNpmPackageCode(args);
      }
    );

    // Tool 2: List Package Files
    this.server.registerTool(
      'list_package_files',
      {
        title: 'List Package Files',
        description: 'List all files in an npm package',
        inputSchema: {
          packageName: z.string().describe('The name of the npm package'),
          version: z.string().optional().describe('Specific version to fetch (optional, defaults to latest)'),
        },
      },
      async ({ packageName, version }) => {
        const args: ListPackageFilesArgs = {
          packageName,
          ...(version !== undefined && { version }),
        };
        return await this.listPackageFiles(args);
      }
    );

    // Tool 3: Get Package Info
    this.server.registerTool(
      'get_package_info',
      {
        title: 'Get Package Info',
        description: 'Get package metadata and information',
        inputSchema: {
          packageName: z.string().describe('The name of the npm package'),
          version: z.string().optional().describe('Specific version to fetch (optional, defaults to latest)'),
        },
      },
      async ({ packageName, version }) => {
        const args: ListPackageFilesArgs = {
          packageName,
          ...(version !== undefined && { version }),
        };
        return await this.getPackageInfo(args);
      }
    );

    // Tool 4: Search NPM Packages
    this.server.registerTool(
      'search_npm_packages',
      {
        title: 'Search NPM Packages',
        description: 'Search for npm packages by keyword, name, or description',
        inputSchema: {
          query: z.string().describe('Search query (keywords, package name, description, etc.)'),
          size: z.number().min(1).max(250).optional().describe('Number of results to return (default: 20, max: 250)'),
          from: z.number().min(0).optional().describe('Starting offset for pagination (default: 0)'),
        },
      },
      async ({ query, size, from }) => {
        const args: SearchPackagesArgs = {
          query,
          ...(size !== undefined && { size }),
          ...(from !== undefined && { from }),
        };
        return await this.searchNpmPackages(args);
      }
    );
  }

  private async searchNpmPackages(args: SearchPackagesArgs) {
    const { query, size = 20, from = 0 } = args;
    
    if (!query?.trim()) {
      throw new McpError(ErrorCode.InvalidParams, 'query is required and must be a non-empty string');
    }
    if (size > 250) {
      throw new McpError(ErrorCode.InvalidParams, 'size cannot exceed 250');
    }

    try {
      const searchResults = await this.performPackageSearch(query.trim(), size, from);
      
      let resultText = `Search Results for "${query}"\n`;
      resultText += `Total packages found: ${searchResults.total}\n`;
      resultText += `Showing ${searchResults.objects.length} results (from ${from})\n\n`;

      for (const result of searchResults.objects) {
        const pkg = result.package;
        const score = result.score;
        
        resultText += `📦 **${pkg.name}** v${pkg.version}\n`;
        resultText += `   ${pkg.description || 'No description available'}\n`;
        
        if (pkg.keywords?.length) {
          resultText += `   Keywords: ${pkg.keywords.join(', ')}\n`;
        }
        
        const authorName = typeof pkg.author === 'string' ? pkg.author : pkg.author?.name;
        if (authorName) resultText += `   Author: ${authorName}\n`;
        
        resultText += `   Score: ${(score.final * 100).toFixed(1)}% (Quality: ${(score.detail.quality * 100).toFixed(1)}%, Popularity: ${(score.detail.popularity * 100).toFixed(1)}%, Maintenance: ${(score.detail.maintenance * 100).toFixed(1)}%)\n`;
        resultText += `   NPM: ${pkg.links.npm}\n`;
        
        if (pkg.links.homepage) resultText += `   Homepage: ${pkg.links.homepage}\n`;
        if (pkg.links.repository) resultText += `   Repository: ${pkg.links.repository}\n`;
        
        resultText += `   Last updated: ${new Date(pkg.date).toLocaleDateString()}\n\n`;
      }

      if (!searchResults.objects.length) {
        resultText += 'No packages found for this search query.\n';
        resultText += 'Try using different keywords or checking spelling.\n';
      }

      return { content: [{ type: 'text' as const, text: resultText }] };
    } catch (error) {
      throw new McpError(
        ErrorCode.InternalError,
        `Failed to search packages: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  private async getPopularPackages(): Promise<ResourceResult> {
    const now = Date.now();
    if (this.popularPackagesCache && (now - this.popularPackagesCacheTime) < CACHE_DURATION) {
      return { 
        contents: [{ 
          uri: 'npm://popular-packages',
          mimeType: 'text/plain',
          text: this.popularPackagesCache 
        }] 
      };
    }

    try {
      const popularQueries = ['react', 'lodash', 'express', 'typescript', 'webpack'];
      const allPopularPackages = new Set<string>();
      const packageDetails: SearchResult[] = [];

      for (const searchTerm of popularQueries) {
        try {
          const results = await this.performPackageSearch(searchTerm, 10, 0);
          for (const result of results.objects) {
            if (!allPopularPackages.has(result.package.name)) {
              allPopularPackages.add(result.package.name);
              packageDetails.push(result.package);
            }
          }
        } catch (error) {
          console.error(`Failed to search for ${searchTerm}:`, error);
        }
      }

      packageDetails.sort((a, b) => {
        const scoreA = (a.name.length < 15 ? 1 : 0) + (a.description ? 1 : 0) + (a.keywords?.length || 0) / 10;
        const scoreB = (b.name.length < 15 ? 1 : 0) + (b.description ? 1 : 0) + (b.keywords?.length || 0) / 10;
        return scoreB - scoreA;
      });

      let resultText = '# 🔥 Most Popular NPM Packages\n\n';
      resultText += `Updated: ${new Date().toISOString()}\n\n`;

      for (let i = 0; i < Math.min(50, packageDetails.length); i++) {
        const pkg = packageDetails[i];
        if (!pkg) continue; // Skip if undefined
        
        resultText += `## ${i + 1}. ${pkg.name}\n`;
        resultText += `**Version:** ${pkg.version}\n`;
        resultText += `**Description:** ${pkg.description || 'No description available'}\n`;
        
        if (pkg.keywords?.length) {
          resultText += `**Keywords:** ${pkg.keywords.slice(0, 5).join(', ')}\n`;
        }
        
        const authorName = typeof pkg.author === 'string' ? pkg.author : pkg.author?.name;
        if (authorName) resultText += `**Author:** ${authorName}\n`;
        
        resultText += `**NPM:** ${pkg.links.npm}\n`;
        if (pkg.links.homepage) resultText += `**Homepage:** ${pkg.links.homepage}\n`;
        if (pkg.links.repository) resultText += `**Repository:** ${pkg.links.repository}\n`;
        resultText += `**Last Updated:** ${new Date(pkg.date).toLocaleDateString()}\n\n`;
      }

      this.popularPackagesCache = resultText;
      this.popularPackagesCacheTime = now;

      return { 
        contents: [{ 
          uri: 'npm://popular-packages',
          mimeType: 'text/plain',
          text: resultText 
        }] 
      };
    } catch (error) {
      throw new McpError(
        ErrorCode.InternalError,
        `Failed to fetch popular packages: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  private async performPackageSearch(query: string, size: number, from: number): Promise<SearchResponse> {
    return new Promise((resolve, reject) => {
      const encodedQuery = encodeURIComponent(query);
      const url = `https://registry.npmjs.org/-/v1/search?text=${encodedQuery}&size=${size}&from=${from}&quality=0.65&popularity=0.98&maintenance=0.5`;
      
      const request = https.get(url, (res) => {
        let data = '';
        
        res.on('data', (chunk: Buffer) => {
          data += chunk.toString();
        });
        
        res.on('end', () => {
          try {
            const searchResults = JSON.parse(data) as SearchResponse;
            resolve(searchResults);
          } catch (error) {
            reject(new Error(`Invalid JSON response: ${error instanceof Error ? error.message : String(error)}`));
          }
        });
      });

      request.on('error', (error) => {
        reject(new Error(`HTTP request failed: ${error.message}`));
      });

      request.setTimeout(15000, () => {
        request.destroy();
        reject(new Error('Search request timeout'));
      });
    });
  }

  private async getNpmPackageCode(args: GetPackageCodeArgs): Promise<ToolResult> {
    const { packageName, version, filePath } = args;
    
    if (!packageName || typeof packageName !== 'string') {
      throw new McpError(ErrorCode.InvalidParams, 'packageName is required and must be a string');
    }

    // Validate package name to prevent injection attacks
    this.validatePackageName(packageName);

    try {
      // Get package metadata to find tarball URL
      const packageInfo = await this.fetchPackageInfo(packageName, version);
      const tarballUrl = packageInfo.dist.tarball;
      
      // Download and extract the tarball
      const extractedPath = await this.downloadAndExtract(tarballUrl, packageName);
      
      if (filePath) {
        // Return specific file
        return await this.getSpecificFile(extractedPath, filePath);
      } else {
        // Return all code files
        return await this.getAllCodeFiles(extractedPath, packageInfo);
      }
    } catch (error) {
      throw new McpError(
        ErrorCode.InternalError,
        `Failed to fetch package code: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  private async listPackageFiles(args: ListPackageFilesArgs): Promise<ToolResult> {
    const { packageName, version } = args;
    
    if (!packageName || typeof packageName !== 'string') {
      throw new McpError(ErrorCode.InvalidParams, 'packageName is required and must be a string');
    }

    // Validate package name
    this.validatePackageName(packageName);

    try {
      const packageInfo = await this.fetchPackageInfo(packageName, version);
      const tarballUrl = packageInfo.dist.tarball;
      
      const extractedPath = await this.downloadAndExtract(tarballUrl, packageName);
      const allFiles = await this.getAllFiles(extractedPath);
      
      const fileList = allFiles
        .map(filePath => path.relative(extractedPath, filePath))
        .sort();
      
      return { 
        content: [{ 
          type: 'text' as const, 
          text: `Package: ${packageName}@${packageInfo.version}\nTotal files: ${fileList.length}\n\nFiles:\n${fileList.join('\n')}`
        }] 
      };
    } catch (error) {
      throw new McpError(
        ErrorCode.InternalError,
        `Failed to list package files: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  private async getPackageInfo(args: ListPackageFilesArgs): Promise<ToolResult> {
    const { packageName, version } = args;
    
    if (!packageName || typeof packageName !== 'string') {
      throw new McpError(ErrorCode.InvalidParams, 'packageName is required and must be a string');
    }

    // Validate package name
    this.validatePackageName(packageName);

    try {
      const packageInfo = await this.fetchPackageInfo(packageName, version);
      
      const info = {
        name: packageInfo.name,
        version: packageInfo.version,
        description: packageInfo.description || 'No description available',
        main: packageInfo.main || 'Not specified',
        types: packageInfo.types || 'Not specified',
        keywords: packageInfo.keywords || [],
        author: packageInfo.author || 'Not specified',
        license: packageInfo.license || 'Not specified',
        homepage: packageInfo.homepage || 'Not specified',
        repository: packageInfo.repository?.url || 'Not specified',
        tarball: packageInfo.dist.tarball,
        shasum: packageInfo.dist.shasum,
        dependencies: Object.keys(packageInfo.dependencies || {}).length,
        devDependencies: Object.keys(packageInfo.devDependencies || {}).length,
      };

      return { 
        content: [{ 
          type: 'text' as const, 
          text: `Package Information:\n${JSON.stringify(info, null, 2)}`
        }] 
      };
    } catch (error) {
      throw new McpError(
        ErrorCode.InternalError,
        `Failed to get package info: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  private async getSpecificFile(extractedPath: string, filePath: string): Promise<ToolResult> {
    // Validate and resolve path to prevent traversal attacks
    let fullFilePath: string;
    try {
      fullFilePath = this.validateAndResolvePath(extractedPath, filePath);
    } catch (error) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `Invalid file path: ${error instanceof Error ? error.message : 'Path traversal detected'}`
      );
    }
    
    if (!fs.existsSync(fullFilePath)) {
      throw new Error(`File not found: ${filePath}`);
    }
    
    const stats = fs.statSync(fullFilePath);
    if (!stats.isFile()) {
      throw new Error(`Path is not a file: ${filePath}`);
    }

    try {
      const content = fs.readFileSync(fullFilePath, 'utf8');
      return { content: [{ type: 'text' as const, text: `File: ${filePath}\n\n${content}` }] };
    } catch (error) {
      throw new Error(`Failed to read file ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async getAllCodeFiles(extractedPath: string, packageInfo: PackageInfo): Promise<ToolResult> {
    const codeFiles = await this.findCodeFiles(extractedPath);
    
    let allContent = `Package: ${packageInfo.name}@${packageInfo.version}\n`;
    allContent += `Description: ${packageInfo.description || 'No description'}\n`;
    allContent += `Code files found: ${codeFiles.length}\n\n`;
    
    const filesToShow = codeFiles.slice(0, MAX_CODE_FILES);
    
    for (const file of filesToShow) {
      const relativePath = path.relative(extractedPath, file.path);
      allContent += `=== ${relativePath} ===\n`;
      allContent += file.content + '\n\n';
    }
    
    if (codeFiles.length > MAX_CODE_FILES) {
      allContent += `... and ${codeFiles.length - MAX_CODE_FILES} more files\n`;
      allContent += `Use 'list_package_files' tool to see all files, then fetch specific files as needed.\n`;
    }
    
    return { content: [{ type: 'text' as const, text: allContent }] };
  }

  private async fetchPackageInfo(packageName: string, version?: string | undefined): Promise<PackageInfo> {
    return new Promise((resolve, reject) => {
      const url = version 
        ? `https://registry.npmjs.org/${encodeURIComponent(packageName)}/${encodeURIComponent(version)}`
        : `https://registry.npmjs.org/${encodeURIComponent(packageName)}/latest`;
      
      const request = https.get(url, (res) => {
        let data = '';
        
        res.on('data', (chunk: Buffer) => {
          data += chunk.toString();
        });
        
        res.on('end', () => {
          try {
            const packageInfo = JSON.parse(data) as PackageInfo;
            
            if (!packageInfo.dist || !packageInfo.dist.tarball) {
              reject(new Error(`Invalid package info: missing tarball URL`));
              return;
            }
            
            resolve(packageInfo);
          } catch (error) {
            reject(new Error(`Invalid JSON response: ${error instanceof Error ? error.message : String(error)}`));
          }
        });
      });

      request.on('error', (error) => {
        reject(new Error(`HTTP request failed: ${error.message}`));
      });

      request.setTimeout(10000, () => {
        request.destroy();
        reject(new Error('Request timeout'));
      });
    });
  }

  private async downloadAndExtract(tarballUrl: string, packageName: string): Promise<string> {
    const sanitizedName = packageName.replace(/[@\/]/g, '_');
    const extractPath = path.join(this.tempDir, sanitizedName);
    
    // Clean up existing directory
    if (fs.existsSync(extractPath)) {
      fs.rmSync(extractPath, { recursive: true });
    }
    fs.mkdirSync(extractPath, { recursive: true });

    return new Promise((resolve, reject) => {
      const request = https.get(tarballUrl, (res) => {
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}: Failed to download tarball`));
          return;
        }

        const gunzip = zlib.createGunzip();
        const extract = tar.extract({
          cwd: extractPath,
          strip: 1, // Remove the 'package' directory wrapper
        });

        res.pipe(gunzip).pipe(extract);

        extract.on('end', () => {
          resolve(extractPath);
        });

        extract.on('error', (error) => {
          reject(new Error(`Extraction failed: ${error.message}`));
        });

        gunzip.on('error', (error) => {
          reject(new Error(`Decompression failed: ${error.message}`));
        });
      });

      request.on('error', (error) => {
        reject(new Error(`Download failed: ${error.message}`));
      });

      request.setTimeout(30000, () => {
        request.destroy();
        reject(new Error('Download timeout'));
      });
    });
  }

  private async findCodeFiles(dir: string): Promise<CodeFile[]> {
    const files: CodeFile[] = [];
    
    const walk = (currentDir: string): void => {
      try {
        const items = fs.readdirSync(currentDir);
        
        for (const item of items) {
          const fullPath = path.join(currentDir, item);
          
          try {
            const stat = fs.statSync(fullPath);
            
            if (stat.isDirectory() && !this.shouldSkipDirectory(item)) {
              walk(fullPath);
            } else if (stat.isFile() && this.isCodeFile(item)) {
              try {
                const content = fs.readFileSync(fullPath, 'utf8');
                files.push({ path: fullPath, content });
              } catch (error) {
                // Skip files that can't be read (binary, permissions, etc.)
                console.error(`Skipping unreadable file: ${fullPath}`);
              }
            }
          } catch (error) {
            // Skip items that can't be stat'd
            console.error(`Skipping inaccessible item: ${fullPath}`);
          }
        }
      } catch (error) {
        // Skip directories that can't be read
        console.error(`Skipping unreadable directory: ${currentDir}`);
      }
    };
    
    walk(dir);
    return files;
  }

  private async getAllFiles(dir: string): Promise<string[]> {
    const files: string[] = [];
    
    const walk = (currentDir: string): void => {
      try {
        const items = fs.readdirSync(currentDir);
        
        for (const item of items) {
          const fullPath = path.join(currentDir, item);
          
          try {
            const stat = fs.statSync(fullPath);
            
            if (stat.isDirectory() && !item.startsWith('.')) {
              walk(fullPath);
            } else if (stat.isFile()) {
              files.push(fullPath);
            }
          } catch (error) {
            // Skip items that can't be stat'd
          }
        }
      } catch (error) {
        // Skip directories that can't be read
      }
    };
    
    walk(dir);
    return files;
  }

  private isCodeFile(fileName: string): boolean {
    return CODE_EXTENSIONS.includes(path.extname(fileName).toLowerCase());
  }

  private shouldSkipDirectory(dirName: string): boolean {
    return dirName.startsWith('.') || SKIP_DIRECTORIES.includes(dirName);
  }

  private validateAndResolvePath(basePath: string, userPath: string): string {
    // Normalize the path to remove .. and ./ sequences
    const normalizedPath = path.normalize(userPath).replace(/^(\.\.[\/\\])+/, '');
    
    // Join with base path
    const fullPath = path.join(basePath, normalizedPath);
    
    // Resolve both paths to absolute form
    const resolvedPath = path.resolve(fullPath);
    const resolvedBasePath = path.resolve(basePath);
    
    // Ensure the resolved path is still within the base path (prevent traversal)
    if (!resolvedPath.startsWith(resolvedBasePath)) {
      throw new McpError(
        ErrorCode.InvalidParams,
        'Access denied: Path traversal attempt detected'
      );
    }
    
    return resolvedPath;
  }

  private validatePackageName(packageName: string): void {
    // Allow @scope/name format and simple names
    // Disallow: ../, ..\\, null bytes, and other suspicious patterns
    if (!/^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/i.test(packageName)) {
      throw new McpError(
        ErrorCode.InvalidParams,
        'Invalid package name format. Package names must follow npm naming conventions.'
      );
    }
    
    // Additional checks
    if (packageName.includes('..') || packageName.includes('\0') || packageName.includes('\n')) {
      throw new McpError(
        ErrorCode.InvalidParams,
        'Invalid package name: contains prohibited characters'
      );
    }
  }

  public async run(): Promise<void> {
    const transportMode = process.env.TRANSPORT_MODE || 'stdio';
    const port = parseInt(process.env.PORT || '3000', 10);

    if (transportMode === 'http') {
      console.error(`Starting NPM Package MCP server in HTTP mode on port ${port}`);
      await this.runHttpServer(port);
    } else {
      console.error('Starting NPM Package MCP server in stdio mode');
      const transport = new StdioServerTransport();
      await this.server.connect(transport);
    }
  }

  private async runHttpServer(port: number): Promise<void> {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
    });
    
    await this.server.connect(transport);

    const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      // CORS headers
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Mcp-Session-Id');
      
      if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
      }

      // Authentication check for all endpoints if AUTH_TOKEN is set
      if (this.authToken && !this.isAuthValid(req.headers.authorization)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized: Invalid or missing authentication token' }));
        return;
      }

      if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ 
          status: 'healthy', 
          service: 'npm-package-mcp-server',
          version: '1.0.0'
        }));
        return;
      }

      if (req.url?.startsWith('/mcp')) {
        try {
          await transport.handleRequest(req, res);
        } catch (error) {
          console.error('Error handling MCP request:', error);
          if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Internal server error' }));
          }
        }
        return;
      }

      res.writeHead(404);
      res.end('Not Found');
    });

    httpServer.listen(port, () => {
      console.error(`NPM Package MCP server listening on http://localhost:${port}`);
      console.error(`MCP endpoint: http://localhost:${port}/mcp`);
      console.error(`Health check: http://localhost:${port}/health`);
    });
  }

  public cleanup(): void {
    if (fs.existsSync(this.tempDir)) {
      try {
        fs.rmSync(this.tempDir, { recursive: true });
      } catch (error) {
        console.error(`Failed to cleanup temp directory: ${error}`);
      }
    }
  }
}

// Handle cleanup
process.on('SIGINT', () => {
  console.error('Received SIGINT, cleaning up...');
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.error('Received SIGTERM, cleaning up...');
  process.exit(0);
});

// Start the server
const server = new NpmPackageServer();

// Cleanup on exit
process.on('exit', () => {
  server.cleanup();
});

server.run().catch((error) => {
  console.error('Server failed to start:', error);
  process.exit(1);
});