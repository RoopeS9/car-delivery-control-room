// Shared by the layout (server) and the toggle (client).
export const THEME_KEY = "cr-theme"

/** Runs before the app (inlined in the layout) so a saved choice never flashes the other theme. */
export const THEME_SCRIPT = `try{var t=localStorage.getItem("${THEME_KEY}");if(t==="light"||t==="dark")document.documentElement.dataset.theme=t}catch(e){}`
