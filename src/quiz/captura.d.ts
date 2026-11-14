declare const captura: {
  fetch(request: Request, env: { DB: D1Database; QUIZ_HASH_SECRET?: string; ORIGENS_PERMITIDAS: string }): Promise<Response>;
};
export default captura;
