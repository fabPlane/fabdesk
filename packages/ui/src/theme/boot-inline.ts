import { THEME_BACKGROUNDS, THEME_FOREGROUNDS, THEME_IDS, UI_THEME_STORAGE_KEY } from "./resolve";

/**
 * Classic IIFE injected into `index.html` (not a module) so it runs before first paint.
 * Keep the logic aligned with `bootstrapTheme` / `resolveThemeId`.
 */
export function themeBootInlineScript(): string {
  return `(function(){var KEY=${JSON.stringify(UI_THEME_STORAGE_KEY)};var IDS=${JSON.stringify([...THEME_IDS])};var BG=${JSON.stringify(THEME_BACKGROUNDS)};function isId(v){return typeof v==="string"&&IDS.indexOf(v)!==-1}function parse(raw){if(!raw)return null;try{var p=JSON.parse(raw);var id=p&&p.state?p.state.themeId:null;return isId(id)?id:null}catch(e){return null}}var prefersDark=false;try{prefersDark=window.matchMedia("(prefers-color-scheme: dark)").matches}catch(e){}var stored=null;try{stored=parse(localStorage.getItem(KEY))}catch(e){}var id=isId(stored)?stored:(prefersDark?"fabplane-dark":"fabplane-light");var dark=id.indexOf("-dark")!==-1;var root=document.documentElement;root.classList.toggle("dark",dark);root.setAttribute("data-theme",dark?"dark":"light");root.setAttribute("data-skin",id.indexOf("plain")===0?"plain":"fabplane");root.style.colorScheme=dark?"dark":"light";var bg=BG[id];if(bg)root.style.backgroundColor=bg})();`;
}

/** Critical first-paint CSS so html/body/#root match the resolved theme before the bundle CSS loads. */
export function themeBootInlineCss(): string {
  const fl = THEME_BACKGROUNDS["fabplane-light"];
  const fd = THEME_BACKGROUNDS["fabplane-dark"];
  const pl = THEME_BACKGROUNDS["plain-light"];
  const pd = THEME_BACKGROUNDS["plain-dark"];
  const flFg = THEME_FOREGROUNDS["fabplane-light"];
  const fdFg = THEME_FOREGROUNDS["fabplane-dark"];
  const plFg = THEME_FOREGROUNDS["plain-light"];
  const pdFg = THEME_FOREGROUNDS["plain-dark"];
  return `html,body,#root{height:100%;margin:0;background:${fl};color:${flFg}}html{color-scheme:light}html.dark,html.dark body,html.dark #root{background:${fd};color:${fdFg}}html.dark{color-scheme:dark}html[data-skin="plain"],html[data-skin="plain"] body,html[data-skin="plain"] #root{background:${pl};color:${plFg}}html.dark[data-skin="plain"],html.dark[data-skin="plain"] body,html.dark[data-skin="plain"] #root{background:${pd};color:${pdFg}}`;
}
