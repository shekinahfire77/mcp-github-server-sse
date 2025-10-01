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
  'releases',
  'user_management',
  'code_search'
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

  // Pull Request operations
  async listPullRequests(owner, repo, state = 'open', per_page = 30) {
    return await this.makeRequest(`/repos/${owner}/${repo}/pulls?state=${state}&per_page=${per_page}`);
  }

  async getPullRequest(owner, repo, pull_number) {
    return await this.makeRequest(`/repos/${owner}/${repo}/pulls/${pull_number}`);
  }

  async createPullRequest(owner, repo, data) {
    return await this.makeRequest(`/repos/${owner}/${repo}/pulls`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
  }

  async mergePullRequest(owner, repo, pull_number, data = {}) {
    return await this.makeRequest(`/repos/${owner}/${repo}/pulls/${pull_number}/merge`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
  }

  // Branch operations
  async listBranches(owner, repo, per_page = 30) {
    return await this.makeRequest(`/repos/${owner}/${repo}/branches?per_page=${per_page}`);
  }

  async getBranch(owner, repo, branch) {
    return await this.makeRequest(`/repos/${owner}/${repo}/branches/${branch}`);
  }

  async createBranch(owner, repo, branch, sha) {
    return await this.makeRequest(`/repos/${owner}/${repo}/git/refs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ref: `refs/heads/${branch}`, sha })
    });
  }

  // Commit operations
  async listCommits(owner, repo, sha = null, per_page = 30) {
    const query = sha ? `?sha=${sha}&per_page=${per_page}` : `?per_page=${per_page}`;
    return await this.makeRequest(`/repos/${owner}/${repo}/commits${query}`);
  }

  async getCommit(owner, repo, ref) {
    return await this.makeRequest(`/repos/${owner}/${repo}/commits/${ref}`);
  }

  // Search operations
  async searchRepositories(query, per_page = 30) {
    return await this.makeRequest(`/search/repositories?q=${encodeURIComponent(query)}&per_page=${per_page}`);
  }

  async searchCode(query, per_page = 30) {
    return await this.makeRequest(`/search/code?q=${encodeURIComponent(query)}&per_page=${per_page}`);
  }

  async searchIssues(query, per_page = 30) {
    return await this.makeRequest(`/search/issues?q=${encodeURIComponent(query)}&per_page=${per_page}`);
  }

  // Comment operations
  async listIssueComments(owner, repo, issue_number) {
    return await this.makeRequest(`/repos/${owner}/${repo}/issues/${issue_number}/comments`);
  }

  async createIssueComment(owner, repo, issue_number, body) {
    return await this.makeRequest(`/repos/${owner}/${repo}/issues/${issue_number}/comments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body })
    });
  }

  async updateIssue(owner, repo, issue_number, data) {
    return await this.makeRequest(`/repos/${owner}/${repo}/issues/${issue_number}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
  }

  // File operations
  async createOrUpdateFile(owner, repo, path, data) {
    return await this.makeRequest(`/repos/${owner}/${repo}/contents/${path}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
  }

  // Repository operations
  async createRepository(data) {
    return await this.makeRequest('/user/repos', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
  }

  async forkRepository(owner, repo) {
    return await this.makeRequest(`/repos/${owner}/${repo}/forks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });
  }

  // User operations
  async getAuthenticatedUser() {
    return await this.makeRequest('/user');
  }

  async getUser(username) {
    return await this.makeRequest(`/users/${username}`);
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
      },
      {
        name: 'github_list_pull_requests',
        description: 'List pull requests in a repository',
        inputSchema: {
          type: 'object',
          properties: {
            owner: { type: 'string', description: 'Repository owner' },
            repo: { type: 'string', description: 'Repository name' },
            state: { type: 'string', enum: ['open', 'closed', 'all'], default: 'open' },
            per_page: { type: 'number', description: 'Number of results per page', default: 30 }
          },
          required: ['owner', 'repo']
        }
      },
      {
        name: 'github_get_pull_request',
        description: 'Get details of a specific pull request',
        inputSchema: {
          type: 'object',
          properties: {
            owner: { type: 'string', description: 'Repository owner' },
            repo: { type: 'string', description: 'Repository name' },
            pull_number: { type: 'number', description: 'Pull request number' }
          },
          required: ['owner', 'repo', 'pull_number']
        }
      },
      {
        name: 'github_create_pull_request',
        description: 'Create a new pull request',
        inputSchema: {
          type: 'object',
          properties: {
            owner: { type: 'string', description: 'Repository owner' },
            repo: { type: 'string', description: 'Repository name' },
            title: { type: 'string', description: 'Pull request title' },
            head: { type: 'string', description: 'Name of the branch with the changes' },
            base: { type: 'string', description: 'Name of the branch to merge changes into' },
            body: { type: 'string', description: 'Pull request description' }
          },
          required: ['owner', 'repo', 'title', 'head', 'base']
        }
      },
      {
        name: 'github_merge_pull_request',
        description: 'Merge an existing pull request',
        inputSchema: {
          type: 'object',
          properties: {
            owner: { type: 'string', description: 'Repository owner' },
            repo: { type: 'string', description: 'Repository name' },
            pull_number: { type: 'number', description: 'Pull request number' },
            merge_method: { type: 'string', enum: ['merge', 'squash', 'rebase'], default: 'merge' }
          },
          required: ['owner', 'repo', 'pull_number']
        }
      },
      {
        name: 'github_list_branches',
        description: 'List branches in a repository',
        inputSchema: {
          type: 'object',
          properties: {
            owner: { type: 'string', description: 'Repository owner' },
            repo: { type: 'string', description: 'Repository name' },
            per_page: { type: 'number', description: 'Number of results per page', default: 30 }
          },
          required: ['owner', 'repo']
        }
      },
      {
        name: 'github_get_branch',
        description: 'Get details of a specific branch',
        inputSchema: {
          type: 'object',
          properties: {
            owner: { type: 'string', description: 'Repository owner' },
            repo: { type: 'string', description: 'Repository name' },
            branch: { type: 'string', description: 'Branch name' }
          },
          required: ['owner', 'repo', 'branch']
        }
      },
      {
        name: 'github_create_branch',
        description: 'Create a new branch in a repository',
        inputSchema: {
          type: 'object',
          properties: {
            owner: { type: 'string', description: 'Repository owner' },
            repo: { type: 'string', description: 'Repository name' },
            branch: { type: 'string', description: 'Name of the new branch' },
            from_branch: { type: 'string', description: 'Source branch to create from', default: 'main' }
          },
          required: ['owner', 'repo', 'branch']
        }
      },
      {
        name: 'github_list_commits',
        description: 'List commits in a repository',
        inputSchema: {
          type: 'object',
          properties: {
            owner: { type: 'string', description: 'Repository owner' },
            repo: { type: 'string', description: 'Repository name' },
            sha: { type: 'string', description: 'SHA or branch to start from' },
            per_page: { type: 'number', description: 'Number of results per page', default: 30 }
          },
          required: ['owner', 'repo']
        }
      },
      {
        name: 'github_get_commit',
        description: 'Get details of a specific commit',
        inputSchema: {
          type: 'object',
          properties: {
            owner: { type: 'string', description: 'Repository owner' },
            repo: { type: 'string', description: 'Repository name' },
            ref: { type: 'string', description: 'Commit SHA' }
          },
          required: ['owner', 'repo', 'ref']
        }
      },
      {
        name: 'github_search_repositories',
        description: 'Search for repositories',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Search query' },
            per_page: { type: 'number', description: 'Number of results per page', default: 30 }
          },
          required: ['query']
        }
      },
      {
        name: 'github_search_code',
        description: 'Search for code in repositories',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Search query' },
            per_page: { type: 'number', description: 'Number of results per page', default: 30 }
          },
          required: ['query']
        }
      },
      {
        name: 'github_search_issues',
        description: 'Search for issues across repositories',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Search query' },
            per_page: { type: 'number', description: 'Number of results per page', default: 30 }
          },
          required: ['query']
        }
      },
      {
        name: 'github_list_issue_comments',
        description: 'List comments on an issue',
        inputSchema: {
          type: 'object',
          properties: {
            owner: { type: 'string', description: 'Repository owner' },
            repo: { type: 'string', description: 'Repository name' },
            issue_number: { type: 'number', description: 'Issue number' }
          },
          required: ['owner', 'repo', 'issue_number']
        }
      },
      {
        name: 'github_create_issue_comment',
        description: 'Add a comment to an issue',
        inputSchema: {
          type: 'object',
          properties: {
            owner: { type: 'string', description: 'Repository owner' },
            repo: { type: 'string', description: 'Repository name' },
            issue_number: { type: 'number', description: 'Issue number' },
            body: { type: 'string', description: 'Comment body' }
          },
          required: ['owner', 'repo', 'issue_number', 'body']
        }
      },
      {
        name: 'github_update_issue',
        description: 'Update an existing issue',
        inputSchema: {
          type: 'object',
          properties: {
            owner: { type: 'string', description: 'Repository owner' },
            repo: { type: 'string', description: 'Repository name' },
            issue_number: { type: 'number', description: 'Issue number' },
            state: { type: 'string', enum: ['open', 'closed'], description: 'Issue state' },
            title: { type: 'string', description: 'Issue title' },
            body: { type: 'string', description: 'Issue body' }
          },
          required: ['owner', 'repo', 'issue_number']
        }
      },
      {
        name: 'github_create_or_update_file',
        description: 'Create or update a file in a repository',
        inputSchema: {
          type: 'object',
          properties: {
            owner: { type: 'string', description: 'Repository owner' },
            repo: { type: 'string', description: 'Repository name' },
            path: { type: 'string', description: 'File path' },
            message: { type: 'string', description: 'Commit message' },
            content: { type: 'string', description: 'Base64 encoded file content' },
            branch: { type: 'string', description: 'Branch to update', default: 'main' }
          },
          required: ['owner', 'repo', 'path', 'message', 'content']
        }
      },
      {
        name: 'github_create_repository',
        description: 'Create a new repository',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Repository name' },
            description: { type: 'string', description: 'Repository description' },
            private: { type: 'boolean', description: 'Make repository private', default: false }
          },
          required: ['name']
        }
      },
      {
        name: 'github_fork_repository',
        description: 'Fork a repository',
        inputSchema: {
          type: 'object',
          properties: {
            owner: { type: 'string', description: 'Repository owner' },
            repo: { type: 'string', description: 'Repository name' },
            organization: { type: 'string', description: 'Optional organization to fork into' }
          },
          required: ['owner', 'repo']
        }
      },
      {
        name: 'github_get_user',
        description: 'Get details of a GitHub user',
        inputSchema: {
          type: 'object',
          properties: {
            username: { type: 'string', description: 'GitHub username' }
          },
          required: ['username']
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

        case 'github_list_pull_requests':
          const pullRequests = await githubClient.listPullRequests(args.owner, args.repo, args.state, args.per_page);
          const prList = pullRequests.map(pr =>
            `#${pr.number}: ${pr.title} (${pr.state}) - ${pr.user.login}`
          ).join('\n');
          content = `Pull Requests in ${args.owner}/${args.repo} (${args.state}):\n\n${prList || 'No pull requests found'}`;
          break;

        case 'github_get_pull_request':
          const pullRequest = await githubClient.getPullRequest(args.owner, args.repo, args.pull_number);
          content = `Pull Request #${pullRequest.number}: ${pullRequest.title}\nState: ${pullRequest.state}\nAuthor: ${pullRequest.user.login}\nCreated: ${pullRequest.created_at}\nURL: ${pullRequest.html_url}`;
          break;

        case 'github_create_pull_request':
          const newPullRequest = await githubClient.createPullRequest(args.owner, args.repo, {
            title: args.title,
            head: args.head,
            base: args.base,
            body: args.body
          });
          content = `Created pull request #${newPullRequest.number}: ${newPullRequest.title}\nURL: ${newPullRequest.html_url}`;
          break;

        case 'github_merge_pull_request':
          const mergedPullRequest = await githubClient.mergePullRequest(args.owner, args.repo, args.pull_number, {
            merge_method: args.merge_method || 'merge'
          });
          content = `Pull Request #${args.pull_number} merged successfully: ${mergedPullRequest.message}`;
          break;

        case 'github_list_branches':
          const branches = await githubClient.listBranches(args.owner, args.repo, args.per_page);
          const branchList = branches.map(branch => branch.name).join('\n');
          content = `Branches in ${args.owner}/${args.repo}:\n\n${branchList}`;
          break;

        case 'github_get_branch':
          const branch = await githubClient.getBranch(args.owner, args.repo, args.branch);
          content = `Branch ${args.branch} in ${args.owner}/${args.repo}\nSHA: ${branch.commit.sha}\nProtected: ${branch.protected}`;
          break;

        case 'github_create_branch':
          const newBranch = await githubClient.createBranch(args.owner, args.repo, args.branch, args.from_branch || 'main');
          content = `Created branch ${args.branch} in ${args.owner}/${args.repo}`;
          break;

        case 'github_list_commits':
          const commits = await githubClient.listCommits(args.owner, args.repo, args.sha, args.per_page);
          const commitList = commits.map(commit =>
            `${commit.sha.slice(0, 7)}: ${commit.commit.message.split('\n')[0]} - ${commit.author.login}`
          ).join('\n');
          content = `Commits in ${args.owner}/${args.repo}:\n\n${commitList}`;
          break;

        case 'github_get_commit':
          const commitDetails = await githubClient.getCommit(args.owner, args.repo, args.ref);
          content = `Commit ${commitDetails.sha}\nAuthor: ${commitDetails.author.login}\nDate: ${commitDetails.commit.author.date}\nMessage: ${commitDetails.commit.message}`;
          break;

        case 'github_search_repositories':
          const repoSearchResults = await githubClient.searchRepositories(args.query, args.per_page);
          const repoSearchList = repoSearchResults.items.map(repo =>
            `${repo.full_name} - ${repo.description || 'No description'} (Stars: ${repo.stargazers_count})`
          ).join('\n');
          content = `Repository search results for "${args.query}":\n\n${repoSearchList}`;
          break;

        case 'github_search_code':
          const codeSearchResults = await githubClient.searchCode(args.query, args.per_page);
          const codeSearchList = codeSearchResults.items.map(code =>
            `${code.repository.full_name}/${code.path}`
          ).join('\n');
          content = `Code search results for "${args.query}":\n\n${codeSearchList}`;
          break;

        case 'github_search_issues':
          const issueSearchResults = await githubClient.searchIssues(args.query, args.per_page);
          const issueSearchList = issueSearchResults.items.map(issue =>
            `${issue.repository_url.split('/').slice(-2).join('/')}#${issue.number}: ${issue.title} (${issue.state})`
          ).join('\n');
          content = `Issue search results for "${args.query}":\n\n${issueSearchList}`;
          break;

        case 'github_list_issue_comments':
          const issueComments = await githubClient.listIssueComments(args.owner, args.repo, args.issue_number);
          const commentList = issueComments.map(comment =>
            `${comment.user.login} at ${comment.created_at}: ${comment.body.split('\n')[0]}`
          ).join('\n');
          content = `Comments on issue #${args.issue_number} in ${args.owner}/${args.repo}:\n\n${commentList || 'No comments'}`;
          break;

        case 'github_create_issue_comment':
          const newComment = await githubClient.createIssueComment(args.owner, args.repo, args.issue_number, args.body);
          content = `Comment added to issue #${args.issue_number} in ${args.owner}/${args.repo}\nURL: ${newComment.html_url}`;
          break;

        case 'github_update_issue':
          const updatedIssue = await githubClient.updateIssue(args.owner, args.repo, args.issue_number, {
            state: args.state,
            title: args.title,
            body: args.body
          });
          content = `Updated issue #${updatedIssue.number} in ${args.owner}/${args.repo}\nState: ${updatedIssue.state}`;
          break;

        case 'github_create_or_update_file':
          const fileUpdate = await githubClient.createOrUpdateFile(args.owner, args.repo, {
            path: args.path,
            message: args.message,
            content: args.content,
            branch: args.branch
          });
          content = `${fileUpdate.content.type === 'file' ? 'Created' : 'Updated'} file ${args.path} in ${args.owner}/${args.repo}\nCommit: ${fileUpdate.commit.sha}`;
          break;

        case 'github_create_repository':
          const newRepository = await githubClient.createRepository({
            name: args.name,
            description: args.description,
            private: args.private || false
          });
          content = `Created repository ${newRepository.full_name}\nURL: ${newRepository.html_url}`;
          break;

        case 'github_fork_repository':
          const forkedRepo = await githubClient.forkRepository(args.owner, args.repo, args.organization);
          content = `Forked ${args.owner}/${args.repo} to ${forkedRepo.full_name}`;
          break;

        case 'github_get_user':
          const userDetails = await githubClient.getUser(args.username);
          content = `User: ${userDetails.name || userDetails.login}\nEmail: ${userDetails.email || 'N/A'}\nCompany: ${userDetails.company || 'N/A'}\nPublic Repos: ${userDetails.public_repos}\nFollowers: ${userDetails.followers}`;
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
  const baseUrl = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
  res.write(`data: {"jsonrpc":"2.0","method":"endpoint","params":{"uri":"${baseUrl}/sse"}}\n\n`);

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