import { readFileSync } from 'node:fs'
// Defaults to the shared laboratory; IMAGE_LAB_PORT/IMAGE_LAB_DIR point the
// checks at an isolated copy so two sessions do not fight over one host.
export const labHost = major => {
  const port = process.env.IMAGE_LAB_PORT || (major === 4 ? 1444 : 1445)
  const dir = process.env.IMAGE_LAB_DIR || `../strapi-plugin-blockscene/.local/strapi${major}`
  return { base: `http://127.0.0.1:${port}`, credentials: JSON.parse(readFileSync(`${dir}/lab-access.json`)) }
}
