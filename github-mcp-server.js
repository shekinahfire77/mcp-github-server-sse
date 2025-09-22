#!/usr/bin/env node

const express = require('express');
const cors = require('cors');
const { spawn } = require('child_process');
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Enable CORS and JSON parsing
app.use(cors());
app.use(express.json());

// Validate required environment variables
if (!process.env.GITHUB_PERSONAL_ACCESS_TOKEN) {
  console.error('Error: GITHUB_PERSONAL_ACCESS_TOKEN environment variable is required');
  process.exit(1);
}

// GitHub MCP Tools Configuration
const GITHUB_TOOLS = [
  'repositories',
  'issues',
  'pull_requests',
  'files',
  'search',
  'commits',
  'branches',
  'releases'
];

// Simple in-memory cache for GitHub MCP responses
const cache = new Map();
const CACHE_DURATION = 60000; // 1 minute

class GitHubMCPServer {
  constructor() {
    this.server = new Server({
      name: 'github-mcp-server',
      version: '1.0.0'
    }, {
      capabilities: {
        tools: {
          listChanged: true
        },
        resources: {
          subscribe: true,
          listChanged: true
        }
      }
    });

    this.setupHandlers();
  }

  setupHandlers() {
    // List available tools
    this.server.setRequestHandler('tools/list', async () => {
      return {
        tools: [
          {
            name: 'github_get_repository',
            description: 'Get information about a GitHub repository',
            inputSchema: {
              type: 'object',
              properties: {
                owner: { type: 'string', description: 'Repository owner' },
                repo: { type: 'string', description: 'Repository name' }
              },
              required: ['owner', 'repo']
            }
          },
          {
            name: 'github_list_repositories',
            description: 'List repositories for the authenticated user',
            inputSchema: {
              type: 'object',
              properties: {
                per_page: { type: 'number', description: 'Number of results per page (max 100)', default: 30 },
                sort: { type: 'string', enum: ['created', 'updated', 'pushed', 'full_name'], default: 'updated' }
              }
            }
          },
          {
            name: 'github_list_issues',
            description: 'List issues for a repository',
            inputSchema: {
              type: 'object',
              properties: {
                owner: { type: 'string', description: 'Repository owner' },
                repo: { type: 'string', description: 'Repository name' },
                state: { type: 'string', enum: ['open', 'closed', 'all'], default: 'open' }
              },
              required: ['owner', 'repo']
            }
          },
          {
            name: 'github_create_issue',
            description: 'Create a new issue in a repository',
            inputSchema: {
              type: 'object',
              properties: {
                owner: { type: 'string', description: 'Repository owner' },
                repo: { type: 'string', description: 'Repository name' },
                title: { type: 'string', description: 'Issue title' },
                body: { type: 'string', description: 'Issue body' },
                labels: { type: 'array', items: { type: 'string' }, description: 'Issue labels' }
              },
              required: ['owner', 'repo', 'title']
            }
          },
          {
            name: 'github_get_file_content',
            description: 'Get the content of a file from a repository',
            inputSchema: {
              type: 'object',
              properties: {
                owner: { type: 'string', description: 'Repository owner' },
                repo: { type: 'string', description: 'Repository name' },
                path: { type: 'string', description: 'File path' },
                ref: { type: 'string', description: 'Branch/commit/tag reference', default: 'main' }
              },
              required: ['owner', 'repo', 'path']
            }
          }
        ]
      };
    });

    // Handle tool calls
    this.server.setRequestHandler('tools/call', async (request) => {
      const { name, arguments: args } = request.params;

      try {
        switch (name) {
          case 'github_get_repository':
            return await this.getRepository(args.owner, args.repo);
          case 'github_list_repositories':
            return await this.listRepositories(args);
          case 'github_list_issues':
            return await this.listIssues(args.owner, args.repo, args.state);
          case 'github_create_issue':
            return await this.createIssue(args);
          case 'github_get_file_content':
            return await this.getFileContent(args.owner, args.repo, args.path, args.ref);
          default:
            throw new Error(`Unknown tool: ${name}`);
        }
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `Error: ${error.message}`
            }
          ],
          isError: true
        };
      }
    });
  }

  async makeGitHubRequest(url, options = {}) {
    const cacheKey = `${url}_${JSON.stringify(options)}`;
    const cached = cache.get(cacheKey);

    if (cached && Date.now() - cached.timestamp < CACHE_DURATION) {
      return cached.data;
    }

    const response = await fetch(url, {
      headers: {
        'Authorization': `token ${process.env.GITHUB_PERSONAL_ACCESS_TOKEN}`,
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'MCP-GitHub-Server/1.0',
        ...options.headers
      },
      ...options
    });

    if (!response.ok) {
      throw new Error(`GitHub API error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    cache.set(cacheKey, { data, timestamp: Date.now() });

    return data;
  }

  async getRepository(owner, repo) {
    const data = await this.makeGitHubRequest(`https://api.github.com/repos/${owner}/${repo}`);

    return {
      content: [
        {
          type: 'text',
          text: `Repository: ${data.full_name}
Description: ${data.description || 'No description'}
Language: ${data.language || 'Unknown'}
Stars: ${data.stargazers_count}
Forks: ${data.forks_count}
Created: ${data.created_at}
Updated: ${data.updated_at}
URL: ${data.html_url}`
        }
      ]
    };
  }

  async listRepositories(args = {}) {
    const { per_page = 30, sort = 'updated' } = args;
    const data = await this.makeGitHubRequest(`https://api.github.com/user/repos?per_page=${per_page}&sort=${sort}`);

    const repoList = data.map(repo =>
      `${repo.full_name} - ${repo.description || 'No description'} (${repo.language || 'Unknown'})`
    ).join('\n');

    return {
      content: [
        {
          type: 'text',
          text: `Found ${data.length} repositories:\n\n${repoList}`
        }
      ]
    };
  }

  async listIssues(owner, repo, state = 'open') {
    const data = await this.makeGitHubRequest(`https://api.github.com/repos/${owner}/${repo}/issues?state=${state}`);

    const issueList = data.map(issue =>
      `#${issue.number}: ${issue.title} (${issue.state}) - ${issue.user.login}`
    ).join('\n');

    return {
      content: [
        {
          type: 'text',
          text: `Issues in ${owner}/${repo} (${state}):\n\n${issueList || 'No issues found'}`
        }
      ]
    };
  }

  async createIssue(args) {
    const { owner, repo, title, body, labels } = args;

    const data = await this.makeGitHubRequest(`https://api.github.com/repos/${owner}/${repo}/issues`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ title, body, labels })
    });

    return {
      content: [
        {
          type: 'text',
          text: `Created issue #${data.number}: ${data.title}\nURL: ${data.html_url}`
        }
      ]
    };
  }

  async getFileContent(owner, repo, path, ref = 'main') {
    const data = await this.makeGitHubRequest(`https://api.github.com/repos/${owner}/${repo}/contents/${path}?ref=${ref}`);

    if (data.type !== 'file') {
      throw new Error('Path is not a file');
    }

    const content = Buffer.from(data.content, 'base64').toString('utf-8');

    return {
      content: [
        {
          type: 'text',
          text: `File: ${path} (${data.size} bytes)\n\n${content}`
        }
      ]
    };
  }

  async start() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.log('GitHub MCP Server started via stdio');
  }
}

// HTTP endpoints for MCP communication
app.get('/health', (req, res) => {
  res.json({ status: 'healthy', service: 'github-mcp-server' });
});

app.get('/mcp', (req, res) => {
  res.json({
    name: 'github-mcp-server',
    version: '1.0.0',
    description: 'GitHub Model Context Protocol Server',
    capabilities: ['tools', 'resources'],
    tools: GITHUB_TOOLS
  });
});

// Start the server
const mcpServer = new GitHubMCPServer();

app.listen(PORT, () => {
  console.log(`GitHub MCP Server running on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
  console.log(`MCP endpoint: http://localhost:${PORT}/mcp`);
});

// Handle graceful shutdown
process.on('SIGTERM', () => {
  console.log('Received SIGTERM, shutting down gracefully');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('Received SIGINT, shutting down gracefully');
  process.exit(0);
});