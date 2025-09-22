# MCP Connections

Model Context Protocol server connections for Claude Code, providing GitHub integration and other MCP services.

## GitHub MCP Server

This repository contains a Node.js HTTP wrapper for GitHub's Model Context Protocol server, designed to be deployed on cloud platforms like Render.

### Features

- **Repository Management**: Get repository information, list repositories
- **Issue Management**: List issues, create new issues
- **File Operations**: Read file contents from repositories
- **Caching**: Built-in response caching for better performance
- **HTTP Interface**: REST API endpoints for health checks and MCP communication

### Setup

1. **Environment Variables**
   ```bash
   cp .env.example .env
   # Edit .env with your GitHub token
   ```

2. **GitHub Token Setup**
   - Go to [GitHub Settings > Personal Access Tokens](https://github.com/settings/tokens)
   - Create a new token with these scopes:
     - `repo` (Full control of private repositories)
     - `read:packages` (Download packages from GitHub Package Registry)
     - `read:org` (Read org and team membership, read org projects)

3. **Local Development**
   ```bash
   npm install
   npm start
   ```

### Deployment to Render

1. **Create Web Service** on Render
2. **Connect Repository**: `https://github.com/shekinahfire77/mcp-connections`
3. **Configure Environment**:
   - Build Command: `npm install`
   - Start Command: `npm start`
   - Environment Variables:
     - `GITHUB_PERSONAL_ACCESS_TOKEN`: Your GitHub token

### API Endpoints

- `GET /health` - Health check endpoint
- `GET /mcp` - MCP server information and capabilities

### Available Tools

- `github_get_repository` - Get repository information
- `github_list_repositories` - List user repositories
- `github_list_issues` - List repository issues
- `github_create_issue` - Create new issue
- `github_get_file_content` - Read file contents

### Usage with Claude Code

After deployment, add the MCP server to Claude Code:

```bash
claude mcp add github-mcp https://your-render-url.onrender.com/mcp -s local
```

## License

MIT