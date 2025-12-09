// scripts/update-readme.js
// ESM module version — requires node >= 18 and package.json { "type": "module" }
import fs from 'fs/promises';
import path from 'path';
import process from 'process';
import { Octokit } from '@octokit/rest';

const AUTOGEN_START = '<!--START_AUTOGEN-->';
const AUTOGEN_END = '<!--END_AUTOGEN-->';
const RECENT_START = '<!--START_RECENT-->';
const RECENT_END = '<!--END_RECENT-->';

function escapeRegExp(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function ensureEnv(name) {
  if (!process.env[name]) {
    console.error(`[ERROR] Missing environment variable: ${name}`);
    process.exit(1);
  }
}

ensureEnv('GITHUB_REPOSITORY');
ensureEnv('GITHUB_TOKEN');

const GITHUB_REPOSITORY = process.env.GITHUB_REPOSITORY;
const OWNER = GITHUB_REPOSITORY.split('/')[0];
const REPO = GITHUB_REPOSITORY.split('/')[1];
const TOKEN = process.env.GITHUB_TOKEN;

const octokit = new Octokit({ auth: TOKEN, userAgent: 'readme-auto-gen' });

/** List public repos for user (non-forks, non-archived) */
async function listPublicRepos(username, perPage = 100, max = 50) {
  const repos = [];
  let page = 1;
  while (repos.length < max) {
    const res = await octokit.repos.listForUser({
      username,
      per_page: perPage,
      page,
      sort: 'updated'
    });
    if (res.status !== 200) break;
    repos.push(...res.data);
    if (res.data.length < perPage) break;
    page++;
  }
  return repos.filter(r => !r.fork && !r.archived && !r.private).slice(0, max);
}

/** Try to extract first image URL from README.md content (raw) */
function extractImageFromMarkdown(content) {
  if (!content) return null;
  // Regex to find markdown image ![alt](url)
  const imgRegex = /!\[.*?\]\((.*?)\)/g;
  let m;
  while ((m = imgRegex.exec(content)) !== null) {
    const url = m[1].trim();
    if (!url) continue;
    // skip data URLs
    if (url.startsWith('data:')) continue;
    return url;
  }
  // fallback: check html <img src="...">
  const htmlImg = /<img[^>]+src=["']([^"']+)["']/i.exec(content);
  if (htmlImg && htmlImg[1]) return htmlImg[1];
  return null;
}

/** Try to get README content (decoded) */
async function getReadmeContent(owner, repo) {
  try {
    const res = await octokit.repos.getReadme({ owner, repo });
    if (res && res.data && res.data.content) {
      const content = Buffer.from(res.data.content, res.data.encoding).toString('utf8');
      return content;
    }
  } catch (e) {
    // README may not exist or access denied
  }
  return null;
}

/** Try common asset file paths and return download_url if exists */
async function checkCommonAssetPaths(owner, repo, branch) {
  const candidates = [
    'assets/screenshot.png','assets/screenshot.jpg','assets/screenshot.webp','assets/preview.png',
    'screenshots/screenshot.png','screenshots/preview.png','screenshots/screenshot.jpg',
    'app_mockup.png','assets/app_mockup.png','docs/screenshot.png','screenshot.png','preview.png'
  ];
  for (const p of candidates) {
    try {
      const res = await octokit.repos.getContent({ owner, repo, path: p, ref: branch });
      if (res && res.data) {
        // For files, GitHub returns download_url in v3 content API for file
        if (res.data.download_url) return res.data.download_url;
        // For directories, ignore
      }
    } catch (e) {
      // not found -> continue
    }
  }
  return null;
}

/** Convert relative path (from README) to raw.githubusercontent URL */
function toRawUrl(owner, repo, branch, relativePath) {
  const clean = relativePath.replace(/^\/+/, '');
  return `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${clean}`;
}

/** Find the best screenshot URL for a repo */
async function findRepoScreenshot(owner, repo) {
  const branch = repo.default_branch || 'main';
  // 1) Try README md
  const readme = await getReadmeContent(owner, repo.name);
  if (readme) {
    const img = extractImageFromMarkdown(readme);
    if (img) {
      if (/^https?:\/\//i.test(img)) return img;
      // relative path — convert to raw url
      return toRawUrl(owner, repo.name, branch, img);
    }
  }

  // 2) Try common asset paths
  const asset = await checkCommonAssetPaths(owner, repo.name, branch);
  if (asset) return asset;

  // 3) Try repository social preview (not always reliable)
  // GitHub Open Graph image: https://opengraph.githubassets.com/<hash>/<owner>/<repo>
  // We won't generate opengraph hash; skip.

  return null;
}

/** Build markdown for a single repo card */
function getSmartDescription(repoName, description) {
  // If description exists, use it
  if (description) return description.replace(/\n/g, ' ');
  
  // Smart fallback descriptions based on repo name
  const descMap = {
    'shrishyamjitaxiservice': '🚖 Taxi & Transportation Service Platform - Real-time booking, dispatch system, payment integration & customer management',
    'hradvertiser': '💼 HR & Recruitment Management System - Job posting, applicant tracking, resume screening & hiring workflow automation',
    'gaushala': '🐄 Cow Sanctuary Management Platform - Community-driven animal welfare, health tracking, donation management & volunteer coordination',
    'silkenweb': '🧵 E-Commerce Platform for Silk & Textile Products - Inventory management, product catalog, secure payments & order tracking',
    'salonsoftware': '💇 Salon & Beauty Services Management - Appointment scheduling, staff management, billing & customer loyalty programs'
  };
  
  return descMap[repoName] || '_Project repository_';
}

function buildProjectCard(repo, screenshot) {
  const title = repo.name;
  const repoUrl = repo.html_url;
  const desc = getSmartDescription(repo.name, repo.description);
  const topics = (repo.topics || []).slice(0, 6).map(t => `\`${t}\``).join(' ') || '—';
  const demo = repo.homepage || (repo.has_pages ? `https://${OWNER}.github.io/${repo.name}` : null);

  const imgMd = screenshot ? `\n\n<p align="center"><a href="${repoUrl}" target="_blank" rel="noopener noreferrer"><img src="${screenshot}" alt="${title} screenshot" width="740" style="max-width:100%;border-radius:8px"></a></p>\n` : '';

  const demoMd = demo ? `**Demo:** [Live Demo](${demo}) · ` : '';

  return `### [${title}](${repoUrl})\n\n${desc}${imgMd}\n**Tech / Topics:** ${topics}\n\n${demoMd}[Repository](${repoUrl})\n`;
}

/** Get recent commits across multiple repos */
async function getRecentCommits(repos, limit = 12) {
  const items = [];
  for (const r of repos) {
    try {
      const res = await octokit.repos.listCommits({ owner: OWNER, repo: r.name, per_page: 3 });
      if (res && res.data && res.data.length) {
        const c = res.data[0];
        const date = c.commit && c.commit.author ? c.commit.author.date : (c.committer ? c.committer.date : null);
        items.push({
          repo: r.name,
          message: c.commit.message.split('\n')[0],
          url: c.html_url,
          date
        });
      }
    } catch (e) {
      // ignore
    }
  }
  items.sort((a, b) => new Date(b.date) - new Date(a.date));
  return items.slice(0, limit);
}

async function main() {
  try {
    console.log(`Generating README autogen for owner: ${OWNER}, repo: ${REPO}`);

    // 1) Optionally read pinned list file from this repo (.github/pinned.json)
    let pinnedList = null;
    try {
      const pinned = await octokit.repos.getContent({ owner: OWNER, repo: REPO, path: '.github/pinned.json' });
      if (pinned && pinned.data && pinned.data.content) {
        pinnedList = JSON.parse(Buffer.from(pinned.data.content, pinned.data.encoding).toString('utf8'));
        console.log('Loaded .github/pinned.json:', pinnedList);
      }
    } catch (e) {
      // no pinned file -> ignore
    }

    // 2) List repos
    const repos = await listPublicRepos(OWNER, 100, 50);
    if (!repos || repos.length === 0) {
      console.warn('No public repositories found for', OWNER);
    }

    // 3) Determine pick list (pinned or top updated)
    const pick = pinnedList && Array.isArray(pinnedList)
      ? pinnedList.map(name => repos.find(r => r.name === name)).filter(Boolean)
      : repos.slice(0, 6);

    // 4) Build project cards
    const cards = [];
    for (const r of pick) {
      let screenshot = null;
      try { screenshot = await findRepoScreenshot(OWNER, r); } catch (e) { screenshot = null; }
      cards.push(buildProjectCard(r, screenshot));
    }
    const projectsMd = cards.join('\n---\n\n');

    // 5) Build recent commits list
    const recent = await getRecentCommits(repos, 12);
    const recentMd = recent.length ? recent.map(c => `- [${c.repo}](${c.url}) — ${c.message} (${new Date(c.date).toLocaleString()})`).join('\n') : '_No recent commits found._';

    // 6) Read local README.md
    const readmePath = path.join(process.cwd(), 'README.md');
    const exists = await fs.stat(readmePath).then(()=>true).catch(()=>false);
    if (!exists) {
      console.error('README.md not found in repo root. Please create README.md with autogen markers and re-run.');
      process.exit(1);
    }
    let readme = await fs.readFile(readmePath, 'utf8');

    if (!readme.includes(AUTOGEN_START) || !readme.includes(AUTOGEN_END)) {
      console.error('Autogen markers not found in README.md. Please add the markers and try again.');
      process.exit(1);
    }

    // 7) Replace markers
    const replaced = readme
      .replace(new RegExp(`${escapeRegExp(AUTOGEN_START)}[\\s\\S]*?${escapeRegExp(AUTOGEN_END)}`, 'm'), `${AUTOGEN_START}\n\n${projectsMd}\n\n${AUTOGEN_END}`)
      .replace(new RegExp(`${escapeRegExp(RECENT_START)}[\\s\\S]*?${escapeRegExp(RECENT_END)}`, 'm'), `${RECENT_START}\n\n${recentMd}\n\n${RECENT_END}`);

    // 8) Write back
    await fs.writeFile(readmePath, replaced, 'utf8');
    console.log('README.md updated successfully (projects + recent activity).');

  } catch (err) {
    console.error('Error in update-readme:', err);
    process.exit(1);
  }
}

main();
