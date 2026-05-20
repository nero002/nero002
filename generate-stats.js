#!/usr/bin/env node

const fs = require('fs')
const path = require('path')
const yaml = require('js-yaml')

const TARGET_USERNAME = process.env.TARGET_USERNAME || 'nero002'
const CACHE_FILE = path.join(__dirname, 'language-colors-cache.json')
const STATS_CACHE_FILE = path.join(__dirname, 'stats-cache.json')
const STATS_CACHE_MAX_AGE = 30 * 24 * 60 * 60 * 1000

const FALLBACK_LANGUAGE_COLORS = {
  JavaScript: '#f1e05a',
  TypeScript: '#3178c6',
  Python: '#3572A5',
  Java: '#b07219',
  Kotlin: '#A97BFF',
  Swift: '#F05138',
  HTML: '#e34c26',
  CSS: '#563d7c',
  Shell: '#89e051',
  C: '#555555',
  'C++': '#f34b7d',
  'C#': '#239120',
  Go: '#00ADD8',
  Dart: '#00B4AB',
  Ruby: '#701516',
  Rust: '#dea584',
  Default: '#555555'
}

function formatNumber(number) {
  return Number(number || 0).toLocaleString('en-US')
}

function encodeBadgeValue(value) {
  return encodeURIComponent(value)
}

function additionsBadge(number) {
  const formatted = formatNumber(number)
  return `![+${formatted}](https://img.shields.io/static/v1?style=plastic&label=&color=brightgreen&message=${encodeBadgeValue(`+${formatted}`)})`
}

function deletionsBadge(number) {
  const formatted = formatNumber(number)
  const label = Number(number || 0) === 0 ? formatted : `-${formatted}`
  return `![${label}](https://img.shields.io/static/v1?style=plastic&label=&color=red&message=${encodeBadgeValue(label)})`
}

function languageBadge(language) {
  return `![${language.name}](https://img.shields.io/static/v1?style=flat-square&label=%E2%A0%80&color=555&labelColor=${encodeBadgeValue(language.color)}&message=${encodeBadgeValue(`${language.name} ${language.percentage}%`)})`
}

async function getToken() {
  if (process.env.USER_API_TOKEN) return process.env.USER_API_TOKEN
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN

  try {
    const { execSync } = require('child_process')
    return execSync('gh auth token', { encoding: 'utf8' }).trim()
  } catch {
    throw new Error('No GitHub token found. Set USER_API_TOKEN, GITHUB_TOKEN, or run gh auth login.')
  }
}

async function loadLanguageColors() {
  if (fs.existsSync(CACHE_FILE)) {
    try {
      const cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'))
      const age = Date.now() - Number(cache.timestamp || 0)
      if (cache.colors && age < 24 * 60 * 60 * 1000) {
        return cache.colors
      }
    } catch {
      // Ignore invalid cache and refresh below.
    }
  }

  try {
    const response = await fetch('https://raw.githubusercontent.com/github/linguist/master/lib/linguist/languages.yml')
    if (!response.ok) throw new Error(`HTTP ${response.status}`)

    const languages = yaml.load(await response.text())
    const colors = {}
    for (const [name, config] of Object.entries(languages || {})) {
      if (config && config.color) colors[name] = config.color
    }

    fs.writeFileSync(CACHE_FILE, `${JSON.stringify({ timestamp: Date.now(), colors }, null, 2)}\n`)
    return colors
  } catch (error) {
    console.warn(`Could not refresh language colors: ${error.message}`)
    return FALLBACK_LANGUAGE_COLORS
  }
}

function languageColor(name, githubColor, languageColors) {
  return githubColor || languageColors[name] || FALLBACK_LANGUAGE_COLORS[name] || FALLBACK_LANGUAGE_COLORS.Default
}

function readStatsCache() {
  if (!fs.existsSync(STATS_CACHE_FILE)) return null

  try {
    return JSON.parse(fs.readFileSync(STATS_CACHE_FILE, 'utf8'))
  } catch {
    return null
  }
}

function isStatsCacheFresh(cache, throughYear) {
  if (!cache || !cache.timestamp || !cache.throughYear || !cache.totals || !cache.yearly) return false
  if (Number(cache.throughYear) !== Number(throughYear)) return false
  return Date.now() - Number(cache.timestamp) <= STATS_CACHE_MAX_AGE
}

function writeStatsCache(throughYear, totals, yearly) {
  const payload = {
    timestamp: Date.now(),
    throughYear,
    totals,
    yearly: Object.fromEntries(
      Object.entries(yearly).filter(([year]) => Number(year) <= Number(throughYear))
    )
  }
  fs.writeFileSync(STATS_CACHE_FILE, `${JSON.stringify(payload, null, 2)}\n`)
}

function isTransientError(errors) {
  return errors.some((error) => {
    const message = String(error.message || '')
    const type = String(error.type || '')
    return type === 'INTERNAL' || message.includes('Something went wrong')
  })
}

async function graphql(token, query, variables = {}) {
  const maxAttempts = 6

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const response = await fetch('https://api.github.com/graphql', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'User-Agent': 'nero002-profile-readme-generator'
      },
      body: JSON.stringify({ query, variables })
    })

    const requestId = response.headers.get('x-github-request-id') || 'n/a'

    if (!response.ok) {
      if (attempt < maxAttempts && [502, 503, 504].includes(response.status)) {
        await waitForRetry(attempt)
        continue
      }
      throw new Error(`GitHub GraphQL HTTP ${response.status} (${requestId})`)
    }

    const payload = await response.json()
    if (payload.errors) {
      if (attempt < maxAttempts && isTransientError(payload.errors)) {
        await waitForRetry(attempt)
        continue
      }
      throw new Error(`GitHub GraphQL error: ${JSON.stringify(payload.errors)}`)
    }

    return payload.data
  }

  throw new Error('GitHub GraphQL request failed after retries')
}

function waitForRetry(attempt) {
  const delay = Math.min(1000 * Math.pow(2, attempt - 1), 15000)
  return new Promise((resolve) => setTimeout(resolve, delay))
}

async function fetchProfile(token, username, fromDate, toDate) {
  const query = `
    query($username: String!, $fromDate: DateTime!, $toDate: DateTime!) {
      user(login: $username) {
        id
        login
        name
        createdAt
        repositories(first: 1, privacy: PUBLIC, ownerAffiliations: OWNER) {
          totalCount
        }
        contributionsCollection {
          contributionYears
        }
        lastYear: contributionsCollection(from: $fromDate, to: $toDate) {
          totalCommitContributions
          totalIssueContributions
          totalPullRequestContributions
        }
      }
    }
  `
  const data = await graphql(token, query, { username, fromDate, toDate })
  if (!data.user) throw new Error(`GitHub user not found: ${username}`)
  return data.user
}

async function fetchAllTimeContributions(token, username, years) {
  const yearly = {}
  const totals = { commits: 0, issues: 0, prs: 0 }

  for (const year of years) {
    const query = `
      query($username: String!, $fromDate: DateTime!, $toDate: DateTime!) {
        user(login: $username) {
          contributionsCollection(from: $fromDate, to: $toDate) {
            totalCommitContributions
            totalIssueContributions
            totalPullRequestContributions
          }
        }
      }
    `
    const data = await graphql(token, query, {
      username,
      fromDate: `${year}-01-01T00:00:00Z`,
      toDate: `${year}-12-31T23:59:59Z`
    })
    const collection = data.user.contributionsCollection
    yearly[year] = {
      commits: collection.totalCommitContributions,
      issues: collection.totalIssueContributions,
      prs: collection.totalPullRequestContributions
    }
    totals.commits += yearly[year].commits
    totals.issues += yearly[year].issues
    totals.prs += yearly[year].prs
  }

  return { totals, yearly }
}

async function fetchTotalStars(token, username) {
  let cursor = null
  let stars = 0

  do {
    const query = `
      query($username: String!, $cursor: String) {
        user(login: $username) {
          repositories(first: 100, after: $cursor, privacy: PUBLIC, ownerAffiliations: OWNER) {
            pageInfo {
              hasNextPage
              endCursor
            }
            nodes {
              stargazerCount
            }
          }
        }
      }
    `
    const data = await graphql(token, query, { username, cursor })
    const page = data.user.repositories
    stars += page.nodes.reduce((sum, repo) => sum + repo.stargazerCount, 0)
    cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null
  } while (cursor)

  return stars
}

async function fetchReposWithCommits(token, username, userId, since, languageColors) {
  const repos = []
  let cursor = null

  do {
    const query = `
      query($username: String!, $cursor: String, $since: GitTimestamp!) {
        user(login: $username) {
          repositories(first: 50, after: $cursor, privacy: PUBLIC, ownerAffiliations: OWNER) {
            pageInfo {
              hasNextPage
              endCursor
            }
            nodes {
              name
              url
              isFork
              defaultBranchRef {
                target {
                  ... on Commit {
                    history(since: $since, author: { id: "${userId}" }) {
                      totalCount
                    }
                  }
                }
              }
              languages(first: 10, orderBy: { field: SIZE, direction: DESC }) {
                edges {
                  size
                  node {
                    name
                    color
                  }
                }
              }
            }
          }
        }
      }
    `
    const data = await graphql(token, query, { username, cursor, since: since.toISOString() })
    const page = data.user.repositories

    for (const repo of page.nodes) {
      const commits = repo.defaultBranchRef?.target?.history?.totalCount || 0
      if (commits <= 0) continue

      const totalLanguageSize = repo.languages.edges.reduce((sum, edge) => sum + edge.size, 0)
      const languages = repo.languages.edges.map((edge) => ({
        name: edge.node.name,
        percentage: totalLanguageSize > 0 ? (edge.size / totalLanguageSize) * 100 : 0,
        color: languageColor(edge.node.name, edge.node.color, languageColors)
      }))

      repos.push({
        name: repo.name,
        url: repo.url,
        commits,
        languages,
        additions: 0,
        deletions: 0
      })
    }

    cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null
  } while (cursor)

  return repos
}

async function fetchRepoLineStats(token, username, repoName, userId, since) {
  let additions = 0
  let deletions = 0
  let cursor = null

  do {
    const query = `
      query($username: String!, $repoName: String!, $cursor: String, $since: GitTimestamp!) {
        repository(owner: $username, name: $repoName) {
          defaultBranchRef {
            target {
              ... on Commit {
                history(first: 100, after: $cursor, since: $since, author: { id: "${userId}" }) {
                  pageInfo {
                    hasNextPage
                    endCursor
                  }
                  nodes {
                    additions
                    deletions
                  }
                }
              }
            }
          }
        }
      }
    `
    const data = await graphql(token, query, {
      username,
      repoName,
      cursor,
      since: since.toISOString()
    })
    const history = data.repository?.defaultBranchRef?.target?.history
    if (!history) break

    additions += history.nodes.reduce((sum, commit) => sum + (commit.additions || 0), 0)
    deletions += history.nodes.reduce((sum, commit) => sum + (commit.deletions || 0), 0)
    cursor = history.pageInfo.hasNextPage ? history.pageInfo.endCursor : null
  } while (cursor)

  return { additions, deletions }
}

function calculateTopLanguages(repos, limit = 5) {
  const weighted = new Map()

  for (const repo of repos) {
    for (const language of repo.languages) {
      const current = weighted.get(language.name) || {
        name: language.name,
        weightedCommits: 0,
        color: language.color
      }
      current.weightedCommits += repo.commits * (language.percentage / 100)
      weighted.set(language.name, current)
    }
  }

  const top = Array.from(weighted.values())
    .sort((a, b) => b.weightedCommits - a.weightedCommits)
    .slice(0, limit)
  const total = top.reduce((sum, language) => sum + language.weightedCommits, 0)

  return top.map((language) => ({
    name: language.name,
    percentage: total > 0 ? Math.round((language.weightedCommits / total) * 100) : 0,
    color: language.color
  }))
}

function buildStatsRows(stats) {
  const allTime = [
    `**${formatNumber(stats.reposOwned)}** public repos`,
    `**${formatNumber(stats.totalCommitsAllTime)}** commits`,
    `**${formatNumber(stats.totalIssuesAllTime)}** issues`,
    `**${formatNumber(stats.totalPRsAllTime)}** PRs`,
    `**${formatNumber(stats.starsReceived)}** stars`
  ]
  const lastYear = [
    `**${formatNumber(stats.totalCommitsLastYear)}** commits`,
    `**${formatNumber(stats.totalIssuesLastYear)}** issues`,
    `**${formatNumber(stats.totalPRsLastYear)}** PRs`,
    `${additionsBadge(stats.totalAdditionsLastYear)} lines added`,
    `${deletionsBadge(stats.totalDeletionsLastYear)} lines removed`
  ]

  return allTime
    .map((item, index) => {
      const language = stats.topLanguages[index]
      return `| ${item} | ${lastYear[index]} | ${language ? languageBadge(language) : ''} |`
    })
    .join('\n')
}

function renderTemplate(template, stats) {
  let readme = template
    .replace(/{{\s*USERNAME\s*}}/g, stats.username)
    .replace(/{{\s*ACCOUNT_AGE\s*}}/g, String(stats.accountAge))
    .replace(/{{\s*TOP_LANGUAGES_ROWS\s*}}/g, buildStatsRows(stats))

  const repoBlock = readme.match(/{{\s*REPO_TEMPLATE_START\s*}}([\s\S]*?){{\s*REPO_TEMPLATE_END\s*}}/)
  if (repoBlock) {
    const repoTemplate = repoBlock[1].replace(/^\n/, '').trimEnd()
    const repos = stats.topRepos.map((repo) => repoTemplate
      .replace(/{{\s*REPO_NAME\s*}}/g, repo.name)
      .replace(/{{\s*REPO_URL\s*}}/g, repo.url)
      .replace(/{{\s*REPO_COMMITS\s*}}/g, formatNumber(repo.commits))
      .replace(/{{\s*REPO_ADDITIONS\s*}}/g, additionsBadge(repo.additions))
      .replace(/{{\s*REPO_DELETIONS\s*}}/g, deletionsBadge(repo.deletions)))
    readme = readme.replace(/{{\s*REPO_TEMPLATE_START\s*}}[\s\S]*?{{\s*REPO_TEMPLATE_END\s*}}/, repos.join('\n'))
  }

  return `${readme.trim()}\n`
}

async function main() {
  const token = await getToken()
  const languageColors = await loadLanguageColors()
  const now = new Date()
  const oneYearAgo = new Date(now)
  oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1)

  const profile = await fetchProfile(token, TARGET_USERNAME, oneYearAgo.toISOString(), now.toISOString())
  const accountAge = Math.floor((now - new Date(profile.createdAt)) / (365.25 * 24 * 60 * 60 * 1000))
  const contributionYears = [...profile.contributionsCollection.contributionYears].sort((a, b) => a - b)
  const currentYear = now.getUTCFullYear()
  const completedContributionYears = contributionYears.filter((year) => year < currentYear)
  const throughYear = completedContributionYears.length ? Math.max(...completedContributionYears) : currentYear - 1
  const statsCache = readStatsCache()
  const cacheFresh = isStatsCacheFresh(statsCache, throughYear)

  let completedYearly = {}
  let completedTotals = { commits: 0, issues: 0, prs: 0 }
  if (cacheFresh) {
    completedYearly = statsCache.yearly
    completedTotals = statsCache.totals
  } else {
    const completed = await fetchAllTimeContributions(token, TARGET_USERNAME, completedContributionYears)
    completedYearly = completed.yearly
    completedTotals = completed.totals
    writeStatsCache(throughYear, completedTotals, completedYearly)
  }
  const liveYears = contributionYears.filter((year) => year > throughYear)
  const live = await fetchAllTimeContributions(token, TARGET_USERNAME, liveYears)
  const allTimeTotals = {
    commits: completedTotals.commits + live.totals.commits,
    issues: completedTotals.issues + live.totals.issues,
    prs: completedTotals.prs + live.totals.prs
  }

  const reposWithCommits = await fetchReposWithCommits(token, TARGET_USERNAME, profile.id, oneYearAgo, languageColors)
  const topRepos = reposWithCommits
    .sort((a, b) => b.commits - a.commits)
    .slice(0, 10)
  const topLanguages = calculateTopLanguages(reposWithCommits, 5)

  let totalAdditionsLastYear = 0
  let totalDeletionsLastYear = 0
  for (const repo of topRepos) {
    const lineStats = await fetchRepoLineStats(token, TARGET_USERNAME, repo.name, profile.id, oneYearAgo)
    repo.additions = lineStats.additions
    repo.deletions = lineStats.deletions
    totalAdditionsLastYear += lineStats.additions
    totalDeletionsLastYear += lineStats.deletions
  }

  const starsReceived = await fetchTotalStars(token, TARGET_USERNAME)
  const stats = {
    username: profile.login,
    accountAge,
    reposOwned: profile.repositories.totalCount,
    starsReceived,
    totalCommitsAllTime: allTimeTotals.commits,
    totalIssuesAllTime: allTimeTotals.issues,
    totalPRsAllTime: allTimeTotals.prs,
    totalCommitsLastYear: profile.lastYear.totalCommitContributions,
    totalIssuesLastYear: profile.lastYear.totalIssueContributions,
    totalPRsLastYear: profile.lastYear.totalPullRequestContributions,
    totalAdditionsLastYear,
    totalDeletionsLastYear,
    topLanguages,
    topRepos
  }

  const template = fs.readFileSync(path.join(__dirname, 'TEMPLATE.md'), 'utf8')
  const readme = renderTemplate(template, stats)
  fs.writeFileSync(path.join(__dirname, 'README.md'), readme)
  console.log(`Generated README.md for ${TARGET_USERNAME}`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
