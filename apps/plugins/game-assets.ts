import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';
import { listFiles } from '../agent/sandbox.ts';

// Example source is bundled before import. Its runtime has no external packages.
const server = new McpServer({ name: 'LightMao game assets', version: '1.0.0' });
server.registerTool(
  'game_asset_inventory',
  {
    description: '按目录列出游戏素材文件名及类型，不推断版权或资源质量。',
    annotations: { readOnlyHint: true, openWorldHint: false },
    inputSchema: z.object({ path: z.string().max(1024).optional() }),
  },
  async ({ path }) => {
    try {
      const files = await listFiles(process.cwd(), path || '.');
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ files, verification: '静态目录清单，未运行游戏引擎' }),
          },
        ],
      };
    } catch (error) {
      return { isError: true, content: [{ type: 'text', text: (error as Error).message }] };
    }
  },
);
void server.connect(new StdioServerTransport());
