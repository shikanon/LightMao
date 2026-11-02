import { readFile } from 'node:fs/promises';

// This module runs only in local maintenance commands. Never import it into web/Agent bundles.
export async function readPrivateConfig(path = 'docs/password.md') {
  const source = await readFile(path, 'utf8');
  const lines = source.split(/\r?\n/);
  const clean = (value) => value.trim().replace(/^[`'"\s]+|[`'"\s;,]+$/g, '');
  function after(label) {
    const index = lines.findIndex((line) => label.test(line));
    if (index < 0) return '';
    const inline = lines[index].replace(/^[^:：=]*[:：=]/, '').trim();
    if (inline && inline !== lines[index].trim()) return clean(inline);
    for (const line of lines.slice(index + 1)) {
      if (!line.trim() || line.trim().startsWith('```')) continue;
      return clean(line.replace(/^[A-Z_]+\s*=\s*/, ''));
    }
    return '';
  }
  const config = {
    ARK_API_KEY: after(/^\s*火山引擎方舟\s*api\s*key\s*[:：=]/i),
    DOUBAO_VOICE_API_KEY: after(/^\s*豆包语音\s*api\s*key\s*[:：=]/i),
  };
  for (const key of ['OSS_REGION', 'OSS_BUCKET', 'OSS_ACCESS_KEY_ID', 'OSS_ACCESS_KEY_SECRET']) {
    const line = lines.find((line) => new RegExp(`^\\s*${key}\\s*=`).test(line));
    config[key] = line ? clean(line.slice(line.indexOf('=') + 1)) : '';
  }
  return config;
}

export const secretNames = [
  'ARK_API_KEY',
  'DOUBAO_VOICE_API_KEY',
  'OSS_ACCESS_KEY_ID',
  'OSS_ACCESS_KEY_SECRET',
  'LIGHTMAO_ADMIN_PASSWORD',
];
