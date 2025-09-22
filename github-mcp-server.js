#!/usr/bin/env node

const express = require('express');
const cors = require('cors');
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