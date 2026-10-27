export const THEME_STORAGE_KEY = "tw-theme";

/** Runs before hydration: dark unless the visitor explicitly chose light. */
export const THEME_INIT_SCRIPT = `try{if(localStorage.getItem("${THEME_STORAGE_KEY}")==="light")document.documentElement.classList.remove("dark")}catch(e){}`;
