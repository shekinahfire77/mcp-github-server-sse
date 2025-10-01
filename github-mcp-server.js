#!/usr/bin/env node

const express = require('express');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Enable CORS and JSON parsing
app.use(cors());
app.use(express.json());

// Session management for SSE connections
const sessions = new Map();

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

// Simple in-memory cache for GitHub responses
const cache = new Map();
const CACHE_DURATION = 60000; // 1 minute

class GitHubAPIClient {
  constructor() {
    this.baseURL = 'https://api.github.com';
  }

  async makeRequest(endpoint, options = {}) {
    const url = `${this.baseURL}${endpoint}`;
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
    return await this.makeRequest(`/repos/${owner}/${repo}`);
  }

  async listRepositories(per_page = 30, sort = 'updated') {
    return await this.makeRequest(`/user/repos?per_page=${per_page}&sort=${sort}`);
  }

  async listIssues(owner, repo, state = 'open') {
    return await this.makeRequest(`/repos/${owner}/${repo}/issues?state=${state}`);
  }

  async createIssue(owner, repo, data) {
    return await this.makeRequest(`/repos/${owner}/${repo}/issues`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
  }

  async getFileContent(owner, repo, path, ref = 'main') {
    return await this.makeRequest(`/repos/${owner}/${repo}/contents/${path}?ref=${ref}`);
  }
}

const githubClient = new GitHubAPIClient();

// MCP Server endpoints
app.get('/mcp/tools', async (req, res) => {
  try {
    const tools = [
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
    ];

    res.json({ tools });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/mcp/tools/call', async (req, res) => {
  try {
    const { name, arguments: args } = req.body;

    let result;
    switch (name) {
      case 'github_get_repository':
        const repo = await githubClient.getRepository(args.owner, args.repo);
        result = {
          content: [
            {
              type: 'text',
              text: `Repository: ${repo.full_name}
Description: ${repo.description || 'No description'}
Language: ${repo.language || 'Unknown'}
Stars: ${repo.stargazers_count}
Forks: ${repo.forks_count}
Created: ${repo.created_at}
Updated: ${repo.updated_at}
URL: ${repo.html_url}`
            }
          ]
        };
        break;

      case 'github_list_repositories':
        const repos = await githubClient.listRepositories(args.per_page, args.sort);
        const repoList = repos.map(repo =>
          `${repo.full_name} - ${repo.description || 'No description'} (${repo.language || 'Unknown'})`
        ).join('\n');
        result = {
          content: [
            {
              type: 'text',
              text: `Found ${repos.length} repositories:\n\n${repoList}`
            }
          ]
        };
        break;

      case 'github_list_issues':
        const issues = await githubClient.listIssues(args.owner, args.repo, args.state);
        const issueList = issues.map(issue =>
          `#${issue.number}: ${issue.title} (${issue.state}) - ${issue.user.login}`
        ).join('\n');
        result = {
          content: [
            {
              type: 'text',
              text: `Issues in ${args.owner}/${args.repo} (${args.state}):\n\n${issueList || 'No issues found'}`
            }
          ]
        };
        break;

      case 'github_create_issue':
        const newIssue = await githubClient.createIssue(args.owner, args.repo, {
          title: args.title,
          body: args.body,
          labels: args.labels
        });
        result = {
          content: [
            {
              type: 'text',
              text: `Created issue #${newIssue.number}: ${newIssue.title}\nURL: ${newIssue.html_url}`
            }
          ]
        };
        break;

      case 'github_get_file_content':
        const fileData = await githubClient.getFileContent(args.owner, args.repo, args.path, args.ref);
        if (fileData.type !== 'file') {
          throw new Error('Path is not a file');
        }
        const content = Buffer.from(fileData.content, 'base64').toString('utf-8');
        result = {
          content: [
            {
              type: 'text',
              text: `File: ${args.path} (${fileData.size} bytes)\n\n${content}`
            }
          ]
        };
        break;

      default:
        throw new Error(`Unknown tool: ${name}`);
    }

    res.json(result);
  } catch (error) {
    res.status(500).json({
      content: [
        {
          type: 'text',
          text: `Error: ${error.message}`
        }
      ],
      isError: true
    });
  }
});

// MCP JSON-RPC Handler
async function handleJsonRpcRequest(message) {
  const { jsonrpc, id, method, params } = message;

  if (method === 'initialize') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: {
          tools: {}
        },
        serverInfo: {
          name: 'github-mcp-server',
          version: '1.0.0'
        }
      }
    };
  }

  if (method === 'tools/list') {
    const tools = [
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
    ];

    return {
      jsonrpc: '2.0',
      id,
      result: { tools }
    };
  }

  if (method === 'tools/call') {
    const { name, arguments: args } = params;

    try {
      let content;

      switch (name) {
        case 'github_get_repository':
          const repo = await githubClient.getRepository(args.owner, args.repo);
          content = `Repository: ${repo.full_name}\nDescription: ${repo.description || 'No description'}\nLanguage: ${repo.language || 'Unknown'}\nStars: ${repo.stargazers_count}\nForks: ${repo.forks_count}\nCreated: ${repo.created_at}\nUpdated: ${repo.updated_at}\nURL: ${repo.html_url}`;
          break;

        case 'github_list_repositories':
          const repos = await githubClient.listRepositories(args.per_page, args.sort);
          const repoList = repos.map(repo =>
            `${repo.full_name} - ${repo.description || 'No description'} (${repo.language || 'Unknown'})`
          ).join('\n');
          content = `Found ${repos.length} repositories:\n\n${repoList}`;
          break;

        case 'github_list_issues':
          const issues = await githubClient.listIssues(args.owner, args.repo, args.state);
          const issueList = issues.map(issue =>
            `#${issue.number}: ${issue.title} (${issue.state}) - ${issue.user.login}`
          ).join('\n');
          content = `Issues in ${args.owner}/${args.repo} (${args.state}):\n\n${issueList || 'No issues found'}`;
          break;

        case 'github_create_issue':
          const newIssue = await githubClient.createIssue(args.owner, args.repo, {
            title: args.title,
            body: args.body,
            labels: args.labels
          });
          content = `Created issue #${newIssue.number}: ${newIssue.title}\nURL: ${newIssue.html_url}`;
          break;

        case 'github_get_file_content':
          const fileData = await githubClient.getFileContent(args.owner, args.repo, args.path, args.ref);
          if (fileData.type !== 'file') {
            throw new Error('Path is not a file');
          }
          const fileContent = Buffer.from(fileData.content, 'base64').toString('utf-8');
          content = `File: ${args.path} (${fileData.size} bytes)\n\n${fileContent}`;
          break;

        default:
          throw new Error(`Unknown tool: ${name}`);
      }

      return {
        jsonrpc: '2.0',
        id,
        result: {
          content: [
            {
              type: 'text',
              text: content
            }
          ]
        }
      };
    } catch (error) {
      return {
        jsonrpc: '2.0',
        id,
        error: {
          code: -32000,
          message: error.message
        }
      };
    }
  }

  return {
    jsonrpc: '2.0',
    id,
    error: {
      code: -32601,
      message: 'Method not found'
    }
  };
}

// MCP Streamable HTTP endpoint (POST for requests)
app.post('/sse', async (req, res) => {
  try {
    const message = req.body;
    const response = await handleJsonRpcRequest(message);
    res.json(response);
  } catch (error) {
    res.status(500).json({
      jsonrpc: '2.0',
      id: req.body.id,
      error: {
        code: -32603,
        message: error.message
      }
    });
  }
});

// MCP SSE endpoint (GET for event stream)
app.get('/sse', (req, res) => {
  const sessionId = uuidv4();

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
    'X-Accel-Buffering': 'no'
  });

  // Store session
  sessions.set(sessionId, { res, id: sessionId });

  // Send initial endpoint message
  res.write(`data: {"jsonrpc":"2.0","method":"endpoint","params":{"uri":"http://localhost:${PORT}/sse"}}\n\n`);

  // Keep-alive ping every 30 seconds
  const keepAliveInterval = setInterval(() => {
    res.write(':ping\n\n');
  }, 30000);

  // Cleanup on connection close
  req.on('close', () => {
    clearInterval(keepAliveInterval);
    sessions.delete(sessionId);
  });
});

app.get('/mcp', (req, res) => {
  res.json({
    name: 'github-mcp-server',
    version: '1.0.0',
    description: 'GitHub Model Context Protocol Server',
    capabilities: ['tools'],
    tools: GITHUB_TOOLS
  });
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'healthy', service: 'github-mcp-server' });
});

// Start the server
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