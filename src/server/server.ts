/**
 * Match thread bot voor r/FCTwente — Devvit Web server.
 *
 * Endpoints:
 *   /internal/on/app/install        — plant recurring sync en post jobs in
 *   /internal/scheduler/sync-matches — haalt wedstrijden op bij football-data.org
 *   /internal/scheduler/post-thread  — post thread als aftrap binnen venster valt
 */

import {once} from 'node:events'
import type {IncomingMessage, ServerResponse} from 'node:http'
import {context, reddit, scheduler, settings} from '@devvit/web/server'
import type {PartialJsonValue, TriggerResponse, UiResponse} from '@devvit/web/shared'
import {Endpoint, EndpointMethod, type ErrorRsp} from '../shared/api.ts'
import {
  dbGetMatch,
  dbMarkPosted,
  dbMatchesInWindow,
  dbUpsertMatch,
} from './db.ts'

// ---------------------------------------------------------------- configuratie

const TEAM_ID = 674 // FC Twente bij football-data.org
const LEAD_MINUTES = 30
const LATE_CUTOFF_MINUTES = 60
const SUBREDDIT = 'FCTwente'
const FD_BASE = 'https://api.football-data.org/v4'

const COMPETITIE_NL: Record<string, string> = {
  Eredivisie: 'Eredivisie',
  'KNVB Beker': 'KNVB Beker',
  'UEFA Europa League': 'Europa League',
  'UEFA Conference League': 'Conference League',
  'UEFA Champions League': 'Champions League',
}

// getDay(): 0=zondag, 1=maandag, ..., 6=zaterdag
const DAGEN = [
  'zondag',
  'maandag',
  'dinsdag',
  'woensdag',
  'donderdag',
  'vrijdag',
  'zaterdag',
]

// -------------------------------------------------------------------- helpers

function formatAmsterdam(utcDate: string): {
  dag: string
  datum: string
  tijd: string
} {
  const d = new Date(utcDate)
  const dag = DAGEN[d.getDay()]!
  const datum = d.toLocaleDateString('nl-NL', {
    timeZone: 'Europe/Amsterdam',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  })
  const tijd = d.toLocaleTimeString('nl-NL', {
    timeZone: 'Europe/Amsterdam',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
  return {dag, datum, tijd}
}

function buildTitle(m: Record<string, string>): string {
  const comp = COMPETITIE_NL[m.competition!] || m.competition!
  const {tijd} = formatAmsterdam(m.kickoff_utc!)
  return `[Match thread] ${m.home} - ${m.away} | ${comp} | ${tijd}`
}

function buildBody(m: Record<string, string>): string {
  const comp = COMPETITIE_NL[m.competition!] || m.competition!
  const {dag, datum, tijd} = formatAmsterdam(m.kickoff_utc!)

  const lines = [
    `## ${m.home} - ${m.away}`,
    '',
    `**Competitie:** ${comp}  `,
    `**Aftrap:** ${dag} ${datum} om ${tijd}  `,
  ]

  if (m.venue) {
    lines.push(`**Stadion:** ${m.venue}  `)
  }

  lines.push(
    '',
    '---',
    '',
    'Praat hier over de wedstrijd. Houd het gezellig!',
    '',
    '^(Deze thread is automatisch geplaatst.)',
  )

  return lines.join('\n')
}

// -------------------------------------------------------------------- router

type AnyRsp = TriggerResponse | UiResponse | ErrorRsp | {ok: boolean; count?: number}

export async function onReq(
  reqMsg: IncomingMessage,
  rspMsg: ServerResponse,
): Promise<void> {
  try {
    await route(reqMsg, rspMsg)
  } catch (err) {
    const msg = `server error; ${err instanceof Error ? err.stack : err}`
    console.error(msg)
    writeJson<ErrorRsp>(500, {error: msg, status: 500}, rspMsg)
  }
}

async function route(
  reqMsg: IncomingMessage,
  rspMsg: ServerResponse,
): Promise<void> {
  const endpoint = reqMsg.url?.slice(1) as Endpoint
  const method = EndpointMethod[endpoint]

  let rsp: AnyRsp
  if (method !== reqMsg.method) {
    rsp = {error: 'not found', status: 404}
  } else {
    switch (endpoint) {
      case Endpoint.OnAppInstall:
        rsp = await routeAppInstall()
        break
      case Endpoint.SyncMatches:
        rsp = await routeSyncMatches()
        break
      case Endpoint.PostThread:
        rsp = await routePostThread()
        break
      case Endpoint.MenuSyncNow:
        rsp = await routeMenuSyncNow()
        break
      case Endpoint.MenuTestPost:
        rsp = await routeMenuTestPost()
        break
      case Endpoint.MenuOverview:
        rsp = await routeMenuOverview()
        break
      default:
        endpoint satisfies never
        rsp = {error: 'not found', status: 404}
        break
    }
  }

  writeJson<PartialJsonValue>('status' in rsp ? rsp.status : 200, rsp, rspMsg)
}

// ----------------------------------------------------------- app install

async function routeAppInstall(): Promise<TriggerResponse> {
  // Plan recurring sync (elke 6 uur)
  await scheduler.runJob({
    name: 'sync-matches',
    cron: '0 */6 * * *',
    data: {},
  })

  // Plan recurring post check (elke 5 minuten)
  await scheduler.runJob({
    name: 'post-thread',
    cron: '*/5 * * * *',
    data: {},
  })

  console.log('Recurring jobs ingepland (sync: 6u, post: 5min)')
  return {}
}

// -------------------------------------------------------------- sync job

async function routeSyncMatches(): Promise<{ok: boolean; count: number}> {
  const token = await settings.get('footballDataToken')
  if (!token) {
    console.error('sync: geen footballDataToken ingesteld')
    return {ok: false, count: 0}
  }

  const today = new Date()
  const future = new Date(today)
  future.setDate(future.getDate() + 30)

  const url =
    `${FD_BASE}/teams/${TEAM_ID}/matches` +
    `?dateFrom=${today.toISOString().split('T')[0]}` +
    `&dateTo=${future.toISOString().split('T')[0]}`

  const resp = await fetch(url, {
    headers: {'X-Auth-Token': String(token)},
  })

  if (!resp.ok) {
    console.error(`sync: API error ${resp.status}`)
    return {ok: false, count: 0}
  }

  const data = (await resp.json()) as {matches?: any[]}
  const matches = data.matches || []
  let seen = 0

  for (const m of matches) {
    const id = String(m.id)
    await dbUpsertMatch(id, {
      fixture_id: id,
      competition: m.competition.name,
      home: m.homeTeam.name,
      away: m.awayTeam.name,
      kickoff_utc: m.utcDate,
      status: m.status,
      venue: m.venue || '',
      updated_at: new Date().toISOString(),
    })
    seen++
  }

  console.log(`sync: ${seen} wedstrijden bijgewerkt`)
  return {ok: true, count: seen}
}

// --------------------------------------------------------------- post job

async function routePostThread(): Promise<{ok: boolean; count: number}> {
  const now = Date.now()
  const upper = now + LEAD_MINUTES * 60 * 1000
  const lower = now - LATE_CUTOFF_MINUTES * 60 * 1000

  const matchIds = await dbMatchesInWindow(lower, upper)
  if (!matchIds.length) return {ok: true, count: 0}

  let posted = 0

  for (const {member: fixtureId} of matchIds) {
    const match = await dbGetMatch(fixtureId)
    if (!match) continue

    // Al gepost?
    if (match.submission_id) continue

    // Afgelopen of uitgesteld?
    const skip = ['FINISHED', 'POSTPONED', 'CANCELLED', 'SUSPENDED']
    if (skip.includes(match.status!)) continue

    const title = buildTitle(match)
    const body = buildBody(match)

    // Post de thread
    const post = await reddit.submitPost({
      subredditName: SUBREDDIT,
      title,
      text: body,
    })

    // submission_id EERST wegschrijven, vóór sticky en flair
    await dbMarkPosted(fixtureId, post.id)
    console.log(`gepost: ${title} (${post.id})`)
    posted++

    // Sticky (niet-fataal)
    try {
      await post.sticky(2)
    } catch (e) {
      console.error('sticky mislukt:', e)
    }

    // Flair (niet-fataal)
    try {
      const flairText = await settings.get('flairText')
      if (flairText) {
        await reddit.setPostFlair({
          subredditName: SUBREDDIT,
          postId: post.id,
          text: String(flairText),
        })
      }
    } catch (e) {
      console.error('flair mislukt:', e)
    }
  }

  return {ok: true, count: posted}
}

// ---------------------------------------------------------- menu: sync now

async function routeMenuSyncNow(): Promise<UiResponse> {
  const result = await routeSyncMatches()
  return {
    showToast: {
      text: result.ok
        ? `Sync klaar: ${result.count} wedstrijden bijgewerkt`
        : 'Sync mislukt — check de footballDataToken setting',
      appearance: result.ok ? 'success' : 'neutral',
    },
  }
}

// --------------------------------------------------------- menu: test post

async function routeMenuTestPost(): Promise<UiResponse> {
  const subredditName = context.subredditName || SUBREDDIT

  const title = buildTitle({
    competition: 'Eredivisie',
    home: 'FC Twente',
    away: 'Test FC',
    kickoff_utc: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
  })

  const body = buildBody({
    competition: 'Eredivisie',
    home: 'FC Twente',
    away: 'Test FC',
    kickoff_utc: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    venue: 'De Grolsch Veste',
  })

  const post = await reddit.submitPost({
    subredditName,
    title,
    text: body,
  })

  console.log(`TEST gepost: ${title} (${post.id})`)

  return {
    showToast: {
      text: `Test-thread gepost: ${post.id}`,
      appearance: 'success',
    },
  }
}

// -------------------------------------------------------- menu: overzicht

async function routeMenuOverview(): Promise<UiResponse> {
  // Haal alle wedstrijden op van nu tot 30 dagen vooruit
  const now = Date.now()
  const future = now + 30 * 24 * 60 * 60 * 1000
  const matchIds = await dbMatchesInWindow(now - 7 * 24 * 60 * 60 * 1000, future)

  if (!matchIds.length) {
    return {
      showToast: {
        text: 'Geen wedstrijden gevonden. Heb je al gesynchroniseerd?',
        appearance: 'neutral',
      },
    }
  }

  const lines: string[] = ['# Overzicht wedstrijden\n']

  for (const {member: fixtureId} of matchIds) {
    const m = await dbGetMatch(fixtureId)
    if (!m) continue

    const {dag, datum, tijd} = formatAmsterdam(m.kickoff_utc!)
    const comp = COMPETITIE_NL[m.competition!] || m.competition!
    const status = m.submission_id ? `✅ Gepost (${m.submission_id})` : '⏳ Nog niet gepost'

    lines.push(`- **${m.home} - ${m.away}** | ${comp}`)
    lines.push(`  ${dag} ${datum} om ${tijd} | ${status}`)
    lines.push('')
  }

  const subredditName = context.subredditName || SUBREDDIT

  const post = await reddit.submitPost({
    subredditName,
    title: '[Bot] Overzicht geplande wedstrijden',
    text: lines.join('\n'),
  })

  return {
    showToast: {
      text: `Overzicht gepost met ${matchIds.length} wedstrijden`,
      appearance: 'success',
    },
    navigateTo: post.url,
  }
}

// ------------------------------------------------------------------- utils

function writeJson<T extends PartialJsonValue>(
  status: number,
  json: Readonly<T>,
  rsp: ServerResponse,
): void {
  const body = JSON.stringify(json)
  const len = Buffer.byteLength(body)
  rsp.writeHead(status, {
    'Content-Length': len,
    'Content-Type': 'application/json',
  })
  rsp.end(body)
}
