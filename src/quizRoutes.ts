import { Hono } from 'hono'
import type { Env } from './types/env'
import captura from './quiz/captura.js'

type QuizBindings = Pick<Env, 'SHARE_DB' | 'QUIZ_HASH_SECRET' | 'QUIZ_ALLOWED_ORIGINS'>
const quizRoutes = new Hono<{ Bindings: QuizBindings }>()
const origensPadrao = 'https://conheca.share-brasil.com,https://conheca-share.pages.dev'

// Rotas públicas isoladas: seu CORS não amplia o acesso às rotas internas.
quizRoutes.all('/api/quiz/*', c => captura.fetch(c.req.raw, {
  DB: c.env.SHARE_DB,
  QUIZ_HASH_SECRET: c.env.QUIZ_HASH_SECRET,
  ORIGENS_PERMITIDAS: c.env.QUIZ_ALLOWED_ORIGINS || origensPadrao,
}))

export { quizRoutes }

export async function limparContadoresQuiz(db: D1Database): Promise<void> {
  await db.prepare('DELETE FROM limites_quiz WHERE expira_em < ?').bind(Math.floor(Date.now()/1000)).run()
}
