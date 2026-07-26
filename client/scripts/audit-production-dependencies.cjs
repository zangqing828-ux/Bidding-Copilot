const { execFileSync } = require('node:child_process')
const https = require('node:https')
const zlib = require('node:zlib')

const CRITICAL_SEVERITY = 'critical'
const MAX_ATTEMPTS = 3
const REQUEST_TIMEOUT_MS = 30_000

function collectProductionVersions() {
  const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  const tree = JSON.parse(
    execFileSync(npmCommand, ['ls', '--omit=dev', '--json', '--all'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'inherit'],
    }),
  )
  const versionsByPackage = new Map()

  function visit(dependencies = {}) {
    for (const [name, dependency] of Object.entries(dependencies)) {
      if (dependency.version) {
        const versions = versionsByPackage.get(name) || new Set()
        versions.add(dependency.version)
        versionsByPackage.set(name, versions)
      }
      visit(dependency.dependencies)
    }
  }

  visit(tree.dependencies)
  return Object.fromEntries(
    [...versionsByPackage.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, versions]) => [name, [...versions].sort()]),
  )
}

function decodeResponse(body, contentEncoding = '') {
  if (body[0] === 0x1f && body[1] === 0x8b) {
    return zlib.gunzipSync(body)
  }
  if (contentEncoding.includes('br')) {
    return zlib.brotliDecompressSync(body)
  }
  if (contentEncoding.includes('deflate')) {
    return zlib.inflateSync(body)
  }
  return body
}

function requestAdvisories(url, payload) {
  return new Promise((resolve, reject) => {
    const request = https.request(
      url,
      {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'accept-encoding': 'identity',
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
          'user-agent': `bidding-copilot-ci/${process.version}`,
        },
        timeout: REQUEST_TIMEOUT_MS,
      },
      (response) => {
        const chunks = []
        response.on('data', (chunk) => chunks.push(chunk))
        response.on('end', () => {
          const body = Buffer.concat(chunks)
          if (response.statusCode !== 200) {
            reject(
              new Error(
                `npm bulk advisory endpoint returned HTTP ${response.statusCode}`,
              ),
            )
            return
          }

          try {
            const decoded = decodeResponse(
              body,
              String(response.headers['content-encoding'] || ''),
            )
            resolve(JSON.parse(decoded.toString('utf8')))
          } catch (error) {
            reject(
              new Error(`npm bulk advisory response was invalid: ${error.message}`),
            )
          }
        })
      },
    )

    request.on('timeout', () => {
      request.destroy(new Error('npm bulk advisory request timed out'))
    })
    request.on('error', reject)
    request.end(payload)
  })
}

async function loadAdvisories(payload) {
  const registry = process.env.npm_config_registry || 'https://registry.npmjs.org/'
  const endpoint = new URL(
    '-/npm/v1/security/advisories/bulk',
    registry.endsWith('/') ? registry : `${registry}/`,
  )
  let lastError

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      return await requestAdvisories(endpoint, payload)
    } catch (error) {
      lastError = error
      if (attempt < MAX_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, attempt * 500))
      }
    }
  }

  throw lastError
}

async function main() {
  const productionVersions = collectProductionVersions()
  const advisoriesByPackage = await loadAdvisories(
    JSON.stringify(productionVersions),
  )

  if (
    !advisoriesByPackage ||
    Array.isArray(advisoriesByPackage) ||
    typeof advisoriesByPackage !== 'object'
  ) {
    throw new Error('npm bulk advisory response must be an object')
  }

  const advisories = Object.entries(advisoriesByPackage).flatMap(
    ([packageName, packageAdvisories]) => {
      if (!Array.isArray(packageAdvisories)) {
        throw new Error(`npm advisory list for ${packageName} must be an array`)
      }
      return packageAdvisories.map((advisory) => ({
        ...advisory,
        packageName,
      }))
    },
  )
  const criticalAdvisories = advisories.filter(
    (advisory) =>
      String(advisory.severity || '').toLowerCase() === CRITICAL_SEVERITY,
  )

  console.log(
    `Production dependency audit checked ${Object.keys(productionVersions).length} packages and found ${advisories.length} applicable advisories.`,
  )

  if (criticalAdvisories.length === 0) {
    console.log('No critical production dependency vulnerabilities found.')
    return
  }

  console.error(
    `Found ${criticalAdvisories.length} critical production dependency vulnerabilities:`,
  )
  for (const advisory of criticalAdvisories) {
    console.error(
      `- ${advisory.packageName}: ${advisory.title || advisory.id} (${advisory.url || 'no URL'})`,
    )
  }
  process.exitCode = 1
}

main().catch((error) => {
  console.error(`Production dependency audit failed: ${error.message}`)
  process.exitCode = 1
})
