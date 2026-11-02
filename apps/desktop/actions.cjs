const { readFile, lstat } = require('node:fs/promises');
const { join, extname } = require('node:path');

function registerDesktopActions({ ipcMain, dialog, shell, win, origin, agentBase, dataDir }) {
  let selecting = false;
  const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
  function trusted(event) {
    if (
      event.sender !== win.webContents ||
      event.senderFrame !== win.webContents.mainFrame ||
      new URL(event.senderFrame.url).origin !== origin
    )
      throw new Error('Untrusted native action caller');
  }
  function validate(input, keys) {
    if (
      !input ||
      typeof input !== 'object' ||
      Array.isArray(input) ||
      Object.keys(input).some((k) => !keys.includes(k)) ||
      typeof input.token !== 'string' ||
      !/^[a-zA-Z0-9_-]{16,512}$/.test(input.token)
    )
      throw new Error('Invalid native action request');
  }
  async function request(path, token, body) {
    const key = await readFile(join(dataDir, 'desktop-control.key'));
    if (key.length !== 32) throw new Error('Desktop control is unavailable');
    const response = await fetch(`${agentBase}${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'X-Lightmao-Desktop-Key': key.toString('hex'),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    const value = await response.json();
    return response.ok
      ? { ok: true, value }
      : { ok: false, status: response.status, error: value.error, code: value.code };
  }
  ipcMain.handle('lightmao:select-project-directory', async (event, input) => {
    trusted(event);
    if (selecting) return { ok: false, status: 409, error: '请先完成已经打开的文件夹选择窗口' };
    selecting = true;
    try {
      validate(input, ['token', 'access', 'projectId']);
      if (
        !['read', 'write'].includes(input.access) ||
        (input.projectId !== undefined && !uuid.test(input.projectId))
      )
        throw new Error('Invalid project authorization');
      const session = await request('/local/native/session', input.token, {});
      if (!session.ok) return session;
      const selection = await dialog.showOpenDialog(win, {
        title: input.access === 'write' ? '允许 Agent 读写此游戏项目' : '允许 Agent 只读此游戏项目',
        buttonLabel: input.access === 'write' ? '选择并允许读写' : '选择并允许只读',
        properties: ['openDirectory'],
      });
      if (selection.canceled || !selection.filePaths.length) return { ok: true, value: null };
      return await request('/local/project-grants', input.token, {
        directory: selection.filePaths[0],
        access: input.access,
        projectId: input.projectId,
      });
    } catch {
      return { ok: false, status: 400, error: '目录选择未完成，请确认本地 Agent 在线后重试' };
    } finally {
      selecting = false;
    }
  });
  ipcMain.handle('lightmao:select-mcp-file', async (event, input) => {
    trusted(event);
    if (selecting) return { ok: false, status: 409, error: '请先完成已经打开的选择窗口' };
    selecting = true;
    try {
      validate(input, ['token', 'projectId']);
      if (!uuid.test(input.projectId)) throw new Error('Invalid project');
      const session = await request('/local/native/session', input.token, {});
      if (!session.ok) return session;
      const selection = await dialog.showOpenDialog(win, {
        title: '导入自包含的 MCP 插件文件',
        buttonLabel: '选择插件文件',
        properties: ['openFile'],
        filters: [{ name: 'Bundled JavaScript MCP server', extensions: ['cjs', 'mjs'] }],
      });
      if (selection.canceled || !selection.filePaths.length) return { ok: true, value: null };
      return await request('/local/mcp-file-grants', input.token, {
        projectId: input.projectId,
        path: selection.filePaths[0],
      });
    } catch {
      return { ok: false, status: 400, error: '插件选择未完成，请确认本地 Agent 在线后重试' };
    } finally {
      selecting = false;
    }
  });
  ipcMain.handle('lightmao:select-skill-directory', async (event, input) => {
    trusted(event);
    if (selecting) return { ok: false, status: 409, error: '请先完成已经打开的选择窗口' };
    selecting = true;
    try {
      validate(input, ['token', 'replaceId']);
      if (
        input.replaceId !== undefined &&
        (typeof input.replaceId !== 'string' || !/^local:[a-f0-9-]{36}$/.test(input.replaceId))
      )
        throw new Error('Invalid skill target');
      const session = await request('/local/native/session', input.token, {});
      if (!session.ok) return session;
      const selection = await dialog.showOpenDialog(win, {
        title: '导入本机 SKILL.md 技能包',
        buttonLabel: '预览技能包',
        properties: ['openDirectory'],
      });
      if (selection.canceled || !selection.filePaths.length) return { ok: true, value: null };
      return await request('/local/skill-directory-grants', input.token, {
        path: selection.filePaths[0],
        replaceId: input.replaceId,
      });
    } catch {
      return { ok: false, status: 400, error: '技能目录选择未完成，请确认本地 Agent 在线后重试' };
    } finally {
      selecting = false;
    }
  });
  ipcMain.handle('lightmao:select-godot', async (event, input) => {
    trusted(event);
    if (selecting) return { ok: false, status: 409, error: '请先完成已经打开的选择窗口' };
    selecting = true;
    try {
      validate(input, ['token', 'projectId']);
      if (!uuid.test(input.projectId)) throw new Error('Invalid project');
      const session = await request('/local/native/session', input.token, {});
      if (!session.ok) return session;
      const selection = await dialog.showOpenDialog(win, {
        title: '选择用于工程验证的 Godot 标准版',
        buttonLabel: '预览引擎',
        properties: ['openFile'],
      });
      if (selection.canceled || !selection.filePaths.length) return { ok: true, value: null };
      return await request('/local/engine-file-grants', input.token, {
        projectId: input.projectId,
        path: selection.filePaths[0],
      });
    } catch {
      return {
        ok: false,
        status: 400,
        error: '引擎选择未完成，请确认 Godot 标准版和本地 Agent 可用',
      };
    } finally {
      selecting = false;
    }
  });
  ipcMain.handle('lightmao:reveal-project-path', async (event, input) => {
    trusted(event);
    try {
      validate(input, ['token', 'projectId', 'path']);
      if (
        !uuid.test(input.projectId) ||
        (input.path !== undefined && (typeof input.path !== 'string' || input.path.length > 4096))
      )
        throw new Error('Invalid project path');
      const target = await request(
        `/local/projects/${input.projectId}/native-target`,
        input.token,
        { path: input.path },
      );
      if (!target.ok) return target;
      shell.showItemInFolder(target.value.path);
      return { ok: true, value: null };
    } catch {
      return { ok: false, status: 400, error: '无法定位文件，请确认项目目录可用' };
    }
  });
  ipcMain.handle('lightmao:open-project-document', async (event, input) => {
    trusted(event);
    try {
      validate(input, ['token', 'projectId', 'path']);
      if (
        !uuid.test(input.projectId) ||
        typeof input.path !== 'string' ||
        input.path.length > 4096 ||
        !['.txt', '.md', '.markdown', '.json', '.csv'].includes(extname(input.path).toLowerCase())
      )
        return {
          ok: false,
          status: 400,
          error: '仅支持打开项目中的普通文本文档；代码可在工作台预览或文件管理器中定位',
        };
      const target = await request(
        `/local/projects/${input.projectId}/native-target`,
        input.token,
        { path: input.path },
      );
      if (!target.ok) return target;
      if (!(await lstat(target.value.path)).isFile())
        return { ok: false, status: 400, error: '请选择普通文本文档' };
      const error = await shell.openPath(target.value.path);
      return error
        ? { ok: false, status: 400, error: '默认应用未能打开文档，请在文件管理器中查看' }
        : { ok: true, value: null };
    } catch {
      return { ok: false, status: 400, error: '无法打开文档，请确认项目目录可用' };
    }
  });
}
module.exports = { registerDesktopActions };
