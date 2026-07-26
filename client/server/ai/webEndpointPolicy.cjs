const dns = require('node:dns').promises;
const net = require('node:net');

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'ip6-localhost',
  'ip6-loopback',
  'metadata.google.internal',
  'metadata.google',
  'metadata.azure.com',
  'instance-data',
  'instance-data.ec2.internal',
]);

const ENDPOINT_NOT_ALLOWED = 'AI_ENDPOINT_NOT_ALLOWED';

function createEndpointPolicyError() {
  const error = new Error('AI 上游地址不允许');
  error.code = ENDPOINT_NOT_ALLOWED;
  return error;
}

function normalizeHostname(value) {
  return String(value || '')
    .trim()
    .replace(/^\[/, '')
    .replace(/\]$/, '')
    .replace(/\.$/, '')
    .toLowerCase();
}

function parseIpv4(address) {
  const parts = String(address || '').split('.');
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) {
    return null;
  }
  const octets = parts.map((part) => Number(part));
  return octets.every((octet) => octet >= 0 && octet <= 255) ? octets : null;
}

function isBlockedIpv4(address) {
  const octets = parseIpv4(address);
  if (!octets) {
    return true;
  }

  const [first, second, third, fourth] = octets;
  if (first === 0 || first === 10 || first === 127 || first >= 224) {
    return true;
  }
  if (first === 100 && second >= 64 && second <= 127) {
    return true;
  }
  if (first === 169 && second === 254) {
    return true;
  }
  if (first === 172 && second >= 16 && second <= 31) {
    return true;
  }
  if (first === 192 && second === 168) {
    return true;
  }
  if (first === 192 && second === 0 && third === 0) {
    return true;
  }
  if (first === 192 && second === 0 && third === 2) {
    return true;
  }
  if (first === 198 && (second === 18 || second === 19)) {
    return true;
  }
  if (first === 198 && second === 51 && third === 100) {
    return true;
  }
  if (first === 203 && second === 0 && third === 113) {
    return true;
  }
  if (first === 192 && second === 0 && third === 0 && fourth === 0) {
    return true;
  }
  return false;
}

function parseIpv6(address) {
  let value = normalizeHostname(address);
  const zoneIndex = value.indexOf('%');
  if (zoneIndex >= 0) {
    value = value.slice(0, zoneIndex);
  }

  if (value.includes('.')) {
    const lastColon = value.lastIndexOf(':');
    const ipv4 = parseIpv4(value.slice(lastColon + 1));
    if (!ipv4) {
      return null;
    }
    const high = ((ipv4[0] << 8) | ipv4[1]).toString(16);
    const low = ((ipv4[2] << 8) | ipv4[3]).toString(16);
    value = `${value.slice(0, lastColon)}:${high}:${low}`;
  }

  const sections = value.split('::');
  if (sections.length > 2) {
    return null;
  }

  const left = sections[0] ? sections[0].split(':').filter(Boolean) : [];
  const right = sections[1] ? sections[1].split(':').filter(Boolean) : [];
  if (sections.length === 1 && left.length !== 8) {
    return null;
  }
  if (sections.length === 2 && left.length + right.length >= 8) {
    return null;
  }

  const parseSection = (section) => {
    if (!/^[0-9a-f]{1,4}$/i.test(section)) {
      return null;
    }
    return Number.parseInt(section, 16);
  };
  const leftValues = left.map(parseSection);
  const rightValues = right.map(parseSection);
  if (leftValues.includes(null) || rightValues.includes(null)) {
    return null;
  }

  const zeroCount = sections.length === 2 ? 8 - leftValues.length - rightValues.length : 0;
  return [...leftValues, ...Array.from({ length: zeroCount }, () => 0), ...rightValues];
}

function ipv6ToMappedIpv4(groups) {
  if (!Array.isArray(groups) || groups.length !== 8) {
    return '';
  }
  const isMapped = groups.slice(0, 5).every((value) => value === 0) && groups[5] === 0xffff;
  if (!isMapped) {
    return '';
  }
  return [
    groups[6] >> 8,
    groups[6] & 0xff,
    groups[7] >> 8,
    groups[7] & 0xff,
  ].join('.');
}

function isBlockedIpv6(address) {
  const groups = parseIpv6(address);
  if (!groups) {
    return true;
  }

  const mappedIpv4 = ipv6ToMappedIpv4(groups);
  if (mappedIpv4) {
    return isBlockedIpv4(mappedIpv4);
  }

  const allZeroAfterFirst = groups.slice(1).every((value) => value === 0);
  if ((groups[0] === 0 && allZeroAfterFirst) || (groups[0] === 0 && groups[1] === 0 && groups[2] === 0 && groups[3] === 0)) {
    return true;
  }
  if ((groups[0] & 0xfe00) === 0xfc00) {
    return true;
  }
  if ((groups[0] & 0xffc0) === 0xfe80) {
    return true;
  }
  if ((groups[0] & 0xff00) === 0xff00) {
    return true;
  }
  if (groups[0] === 0x2001 && groups[1] === 0x0db8) {
    return true;
  }
  if ((groups[0] & 0xffc0) === 0xfec0) {
    return true;
  }
  return false;
}

function isBlockedAddress(address) {
  const normalized = normalizeHostname(address);
  if (net.isIPv4(normalized)) {
    return isBlockedIpv4(normalized);
  }
  if (net.isIPv6(normalized)) {
    return isBlockedIpv6(normalized);
  }
  return true;
}

function isBlockedHostname(hostname) {
  const normalized = normalizeHostname(hostname);
  return BLOCKED_HOSTNAMES.has(normalized)
    || normalized.endsWith('.localhost')
    || normalized.endsWith('.local')
    || normalized.endsWith('.internal')
    || normalized.includes('metadata.google.internal')
    || normalized.includes('metadata.azure.com')
    || normalized === 'metadata';
}

function normalizeLookupResults(result) {
  const entries = Array.isArray(result) ? result : [result];
  return entries
    .map((item) => {
      if (typeof item === 'string') {
        return { address: item, family: 0 };
      }
      if (!item || typeof item !== 'object') {
        return null;
      }
      if (typeof item.address !== 'string') {
        return null;
      }
      return {
        address: item.address,
        family: Number(item.family) || 0,
      };
    })
    .filter(Boolean)
    .filter((item) => item.address);
}

function normalizeFamilyHint(options) {
  const family = Number(options?.family);
  return Number.isInteger(family) ? family : 0;
}

function promiseFromLookup(lookupFn, hostname, options) {
  return new Promise((resolve, reject) => {
    let settled = false;

    const finish = (error, value) => {
      if (settled) {
        return;
      }
      settled = true;
      if (error) {
        reject(error);
        return;
      }
      resolve(value);
    };

    try {
      if (lookupFn.length >= 3) {
        const lookupCallback = (error, addressOrArray, family) => {
          if (error) {
            return finish(error);
          }
          const records = normalizeLookupResults(
            Array.isArray(addressOrArray) ? addressOrArray : { address: addressOrArray, family },
          );
          finish(null, records);
        };
        const callbackResult = lookupFn(hostname, options, lookupCallback);
        if (callbackResult && typeof callbackResult.then === 'function') {
          callbackResult
            .then((value) => finish(null, normalizeLookupResults(value)))
            .catch((error) => finish(error));
        }
      } else {
        const result = lookupFn(hostname, options);
        if (result && typeof result.then === 'function') {
          result.then((value) => finish(null, normalizeLookupResults(value))).catch((error) => finish(error));
        } else {
          finish(null, normalizeLookupResults(result));
        }
      }
    } catch (error) {
      finish(error);
    }
  });
}

function filterSafeLookupResults(result) {
  const records = normalizeLookupResults(result);
  if (!records.length) {
    throw createEndpointPolicyError();
  }
  if (records.some((record) => isBlockedAddress(record.address))) {
    throw createEndpointPolicyError();
  }
  const safe = records.filter((record) => !isBlockedAddress(record.address));
  if (!safe.length) {
    throw createEndpointPolicyError();
  }
  return safe;
}

function pickSafeRecord(records, familyHint) {
  if (!Array.isArray(records) || !records.length) {
    throw createEndpointPolicyError();
  }
  const normalizedHint = Number(familyHint) || 0;
  if (normalizedHint > 0) {
    const matched = records.find((record) => Number(record.family) === normalizedHint && Number(record.family) > 0);
    if (matched) {
      return matched;
    }
  }
  return records[0];
}

async function resolveSafeConnectRecord(lookup, hostname, options) {
  const records = filterSafeLookupResults(await promiseFromLookup(lookup, hostname, { all: true, verbatim: true }));
  const familyHint = normalizeFamilyHint(options);
  const record = pickSafeRecord(records, familyHint);
  return {
    address: record.address,
    family: record.family || familyHint || 0,
  };
}

function createConnectLookup(lookup) {
  return (hostname, options, callback) => {
    const result = resolveSafeConnectRecord(lookup, hostname, options);
    if (typeof callback !== 'function') {
      return result;
    }

    result.then(
      (record) => callback(null, record.address, record.family),
      (error) => callback(error),
    );
    return undefined;
  };
}

function createWebEndpointPolicy(options = {}) {
  const env = options.env || process.env;
  const production = options.production === undefined
    ? env.NODE_ENV === 'production'
    : Boolean(options.production);
  const allowHttp = !production && (options.allowHttp === true || env.WEB_AI_ALLOW_HTTP === '1');
  const lookup = typeof options.lookup === 'function' ? options.lookup : dns.lookup.bind(dns);
  const connectLookup = createConnectLookup(lookup);

  const { Agent } = require('undici');
  // 仅供模块测试注入；生产环境始终创建带安全 lookup 的 Undici Agent。
  const dispatcher = !production && options.__testDispatcher
    ? options.__testDispatcher
    : new Agent({
      connect: {
        lookup: connectLookup,
      },
    });
  const policyRequestOptions = { dispatcher };
  let closePromise = null;

  async function assertAllowed(endpoint) {
    let parsed;
    try {
      parsed = new URL(String(endpoint || '').trim());
    } catch {
      throw createEndpointPolicyError();
    }

    if (!['https:', 'http:'].includes(parsed.protocol)
      || (parsed.protocol === 'http:' && !allowHttp)
      || parsed.username
      || parsed.password) {
      throw createEndpointPolicyError();
    }

    const hostname = normalizeHostname(parsed.hostname);
    if (!hostname || isBlockedHostname(hostname)) {
      throw createEndpointPolicyError();
    }

    if (net.isIP(hostname)) {
      if (isBlockedAddress(hostname)) {
        throw createEndpointPolicyError();
      }
      return policyRequestOptions;
    }

    try {
      const records = filterSafeLookupResults(await promiseFromLookup(lookup, hostname, { all: true, verbatim: true }));
      if (!records.length) {
        throw createEndpointPolicyError();
      }
      return policyRequestOptions;
    } catch {
      throw createEndpointPolicyError();
    }
  }

  function close() {
    if (closePromise) {
      return closePromise;
    }

    const attempt = Promise.resolve().then(() => dispatcher.close());
    closePromise = attempt;
    void attempt.then(
      () => undefined,
      () => {
        if (closePromise === attempt) {
          closePromise = null;
        }
      },
    );
    return attempt;
  }

  function getConnectLookup() {
    return connectLookup;
  }

  return Object.freeze({
    assertAllowed,
    validate: assertAllowed,
    close,
    getConnectLookup,
  });
}

module.exports = {
  ENDPOINT_NOT_ALLOWED,
  createWebEndpointPolicy,
  isBlockedAddress,
  isBlockedHostname,
};
