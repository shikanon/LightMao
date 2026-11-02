import { readdir, realpath, rm } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

/** Keep the reachable part of an already verified, locked pnpm installation. */
export async function selectBackendDependencies(source, required) {
  const root = await realpath(join(source, 'node_modules'));
  const store = await realpath(join(root, '.pnpm'));
  const kept = new Set(),
    queue = [];
  async function include(target) {
    const resolved = await realpath(target);
    if (!resolved.startsWith(store + sep))
      throw Error('Dependency is outside the locked staging graph');
    const key = relative(store, resolved).split(sep)[0];
    if (key === 'node_modules' || !key) throw Error('Invalid package graph node');
    if (!kept.has(key)) {
      kept.add(key);
      queue.push(key);
    }
  }
  async function links(directory, callback) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) await callback(path);
      else if (entry.isDirectory()) await links(path, callback);
    }
  }
  for (const name of required) await include(join(root, name));
  for (let cursor = 0; cursor < queue.length; cursor++)
    await links(join(store, queue[cursor]), include);
  // Remove hoisted aliases whose concrete package is not in the closure before
  // deleting package directories; the remaining aliases stay relocatable.
  await links(join(store, 'node_modules'), async (path) => {
    const target = await realpath(path),
      key = relative(store, target).split(sep)[0];
    if (!kept.has(key)) await rm(path);
  });
  await rm(join(store, 'node_modules', '.bin'), { recursive: true, force: true });
  let removed = 0;
  for (const entry of await readdir(store, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || kept.has(entry.name)) continue;
    await rm(join(store, entry.name), { recursive: true, force: true });
    if (entry.isDirectory()) removed++;
  }
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.name === '.pnpm') continue;
    if (entry.name.startsWith('@') && entry.isDirectory()) {
      for (const child of await readdir(join(root, entry.name)))
        if (!required.includes(entry.name + '/' + child))
          await rm(join(root, entry.name, child), { recursive: true, force: true });
      if (!(await readdir(join(root, entry.name))).length)
        await rm(join(root, entry.name), { recursive: true });
    } else if (!required.includes(entry.name))
      await rm(join(root, entry.name), { recursive: true, force: true });
  }
  return { kept: kept.size, removed };
}
