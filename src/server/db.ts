/**
 * Redis-laag voor wedstrijdopslag.
 *
 * Elke wedstrijd is een hash `match:{fixture_id}` met velden:
 *   fixture_id, competition, home, away, kickoff_utc, status, venue,
 *   submission_id (leeg = nog niet gepost), posted_at, updated_at
 *
 * Sorted set `matches:by_kickoff` voor time-range queries (score = epoch ms).
 */

import {redis} from '@devvit/web/server'

export interface MatchFields {
  fixture_id: string
  competition: string
  home: string
  away: string
  kickoff_utc: string
  status: string
  venue: string
  submission_id: string
  posted_at: string
  updated_at: string
}

/** Upsert een wedstrijd. Bewaar bestaande submission_id. */
export async function dbUpsertMatch(
  fixtureId: string,
  fields: Omit<MatchFields, 'submission_id' | 'posted_at'>,
): Promise<void> {
  const key = `match:${fixtureId}`

  // Bewaar bestaande submission_id — mag nooit overschreven worden
  const existing = await redis.hGet(key, 'submission_id')

  const data: Record<string, string> = {...fields}
  if (!existing) {
    data.submission_id = ''
    data.posted_at = ''
  }

  await redis.hSet(key, data)

  // Sorted set voor time-based queries
  const kickoff = new Date(fields.kickoff_utc).getTime()
  await redis.zAdd('matches:by_kickoff', {member: fixtureId, score: kickoff})
}

/** Haal wedstrijden op in een tijdvenster (epoch ms). */
export async function dbMatchesInWindow(
  lower: number,
  upper: number,
): Promise<{member: string; score: number}[]> {
  return redis.zRange('matches:by_kickoff', lower, upper, {by: 'score'})
}

/** Haal alle velden van een wedstrijd op. */
export async function dbGetMatch(
  fixtureId: string,
): Promise<Record<string, string> | null> {
  const data = await redis.hGetAll(`match:${fixtureId}`)
  if (!data || !data.fixture_id) return null
  return data
}

/** Markeer een wedstrijd als gepost. */
export async function dbMarkPosted(
  fixtureId: string,
  submissionId: string,
): Promise<void> {
  await redis.hSet(`match:${fixtureId}`, {
    submission_id: submissionId,
    posted_at: new Date().toISOString(),
  })
}
