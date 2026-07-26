// 加密配置 Store：per-account 配置，API Key 用 AES-256-GCM 加密。
// 主密钥从 CONFIG_ENCRYPTION_KEY 环境变量读取。
// load() 返回脱敏配置（Key 只显示是否已配置 + 末尾 4 字符）。
// loadDecrypted() 返回完整配置（仅服务端内部用）。
// save(config) 加密后保存，不回显明文。
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { normalizeConfig } = require('../../core/configStore.cjs');

const ENCRYPTED_FIELDS = [
  'api_key',
  'components.file_parser.mineru_token',
];

// 从 text_model_profiles 和 image_model_profiles 中提取需要加密的字段路径
function getSensitiveFieldPaths(config) {
  const paths = [...ENCRYPTED_FIELDS];

  if (config.text_model_profiles) {
    for (const provider of Object.keys(config.text_model_profiles)) {
      if (config.text_model_profiles[provider].api_key) {
        paths.push(`text_model_profiles.${provider}.api_key`);
      }
    }
  }

  if (config.image_model_profiles) {
    for (const provider of Object.keys(config.image_model_profiles)) {
      if (config.image_model_profiles[provider].api_key) {
        paths.push(`image_model_profiles.${provider}.api_key`);
      }
    }
  }

  if (config.image_model?.api_key) {
    paths.push('image_model.api_key');
  }

  return paths;
}

function hasPlaintextSensitiveValue(config) {
  return getSensitiveFieldPaths(config || {}).some((fieldPath) => {
    const value = getValueByPath(config, fieldPath);
    return value && typeof value === 'string' && !value.startsWith('enc:v1:');
  });
}

function getValueByPath(obj, fieldPath) {
  return fieldPath.split('.').reduce((acc, key) => acc?.[key], obj);
}

function setValueByPath(obj, fieldPath, value) {
  const keys = fieldPath.split('.');
  const lastKey = keys.pop();
  const target = keys.reduce((acc, key) => {
    if (!acc[key]) acc[key] = {};
    return acc[key];
  }, obj);
  target[lastKey] = value;
}

function getEncryptionKey() {
  const key = process.env.CONFIG_ENCRYPTION_KEY;
  if (!key) {
    throw new Error('CONFIG_ENCRYPTION_KEY 未设置');
  }
  // 派生 32 字节密钥
  return crypto.createHash('sha256').update(key).digest();
}

function encrypt(plaintext) {
  if (!plaintext) return null;
  const key = getEncryptionKey();
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `enc:v1:${nonce.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`;
}

function decrypt(encryptedValue) {
  if (!encryptedValue || typeof encryptedValue !== 'string' || !encryptedValue.startsWith('enc:v1:')) {
    return encryptedValue;
  }
  const parts = encryptedValue.split(':');
  if (parts.length !== 5) return null;
  const nonce = Buffer.from(parts[2], 'hex');
  const tag = Buffer.from(parts[3], 'hex');
  const encrypted = Buffer.from(parts[4], 'hex');
  const key = getEncryptionKey();
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}

function maskKey(key) {
  if (!key) return null;
  if (key.length <= 4) return '****';
  return `****${key.slice(-4)}`;
}

function cloneConfig(config) {
  return JSON.parse(JSON.stringify(config || {}));
}

function ensureAnalyticsIdentity(config) {
  const next = { ...config };
  let changed = false;
  if (!next.analytics_client_id) {
    next.analytics_client_id = crypto.randomUUID();
    changed = true;
  }
  if (!next.analytics_created_at) {
    next.analytics_created_at = new Date().toISOString();
    changed = true;
  }
  return { config: next, changed };
}

function createEncryptedConfigStore({ configPath }) {
  function readRaw() {
    if (!fs.existsSync(configPath)) {
      return null;
    }
    const raw = fs.readFileSync(configPath, 'utf-8');
    return JSON.parse(raw);
  }

  function writeRaw(data) {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    const tmp = `${configPath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
    fs.renameSync(tmp, configPath);
  }

  function writeEncryptedConfig(config) {
    const persisted = cloneConfig(config);
    const sensitivePaths = getSensitiveFieldPaths(persisted);
    for (const fieldPath of sensitivePaths) {
      const value = getValueByPath(persisted, fieldPath);
      if (value && typeof value === 'string' && !value.startsWith('enc:v1:')) {
        setValueByPath(persisted, fieldPath, encrypt(value));
      }
    }
    writeRaw(persisted);
  }

  function loadDecrypted() {
    const raw = readRaw();
    const config = normalizeConfig(raw || {});
    // 解密敏感字段
    const sensitivePaths = getSensitiveFieldPaths(config);
    for (const fieldPath of sensitivePaths) {
      const value = getValueByPath(config, fieldPath);
      if (value && typeof value === 'string' && value.startsWith('enc:v1:')) {
        setValueByPath(config, fieldPath, decrypt(value));
      }
    }
    const identity = ensureAnalyticsIdentity(config);
    if (!raw || identity.changed || hasPlaintextSensitiveValue(raw)) {
      writeEncryptedConfig(identity.config);
    }
    return identity.config;
  }

  function load() {
    const config = loadDecrypted();
    // 脱敏：只返回是否已配置 + 末尾 4 字符 + 非敏感字段
    const masked = JSON.parse(JSON.stringify(config));
    const sensitivePaths = getSensitiveFieldPaths(config);
    for (const fieldPath of sensitivePaths) {
      const value = getValueByPath(masked, fieldPath);
      if (value) {
        setValueByPath(masked, fieldPath, maskKey(value));
      }
    }
    return masked;
  }

  function save(newConfig) {
    const current = loadDecrypted();
    const incoming = newConfig && typeof newConfig === 'object' ? newConfig : {};
    const merged = normalizeConfig({
      ...current,
      ...incoming,
      text_model_profiles: {
        ...current.text_model_profiles,
        ...(incoming.text_model_profiles || {}),
      },
      image_model_profiles: {
        ...current.image_model_profiles,
        ...(incoming.image_model_profiles || {}),
      },
      agent_mode_scenarios: {
        ...current.agent_mode_scenarios,
        ...(incoming.agent_mode_scenarios || {}),
      },
      // Analytics 身份由服务端生成并保持稳定，不能被浏览器回传值覆盖。
      analytics_client_id: current.analytics_client_id,
      analytics_created_at: current.analytics_created_at,
    });
    // 加密敏感字段
    const sensitivePaths = getSensitiveFieldPaths(merged);
    for (const fieldPath of sensitivePaths) {
      const value = getValueByPath(merged, fieldPath);
      if (value && typeof value === 'string' && !value.startsWith('enc:v1:')) {
        // 拒绝脱敏值作为新 key：以 **** 开头视为未修改，保持原加密值。
        // 这防止前端回传脱敏值 ****<last4> 被当真实 key 加密导致密钥损坏。
        if (value.startsWith('****')) {
          setValueByPath(merged, fieldPath, getValueByPath(current, fieldPath));
        } else {
          setValueByPath(merged, fieldPath, encrypt(value));
        }
      }
    }
    writeEncryptedConfig(merged);
    return {
      success: true,
      message: '配置已保存',
    };
  }

  return { load, loadDecrypted, save };
}

module.exports = { createEncryptedConfigStore, encrypt, decrypt, maskKey };
