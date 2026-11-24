import React,{createContext,useContext,useEffect,useState} from 'react';
// To add a theme: add an entry here and a [data-theme="id"] block in styles.css.
export const THEMES=[{id:'calcium',label:'Calcium'},{id:'claude',label:'Claude'},{id:'claude-dark',label:'Claude Dark'}];
const Ctx=createContext({theme:'calcium',setTheme(){}});
export const useTheme=()=>useContext(Ctx);
export function ThemeProvider({children}){
  const [theme,setTheme]=useState(()=>{try{const t=localStorage.getItem('lc_theme');return THEMES.some(x=>x.id===t)?t:'calcium'}catch{return 'calcium'}});
  useEffect(()=>{document.documentElement.dataset.theme=theme;try{localStorage.setItem('lc_theme',theme)}catch{}},[theme]);
  return <Ctx.Provider value={{theme,setTheme}}>{children}</Ctx.Provider>;
}
export function ThemeSwitcher(){
  const {theme,setTheme}=useTheme();
  return <select className="theme-sel" value={theme} onChange={e=>setTheme(e.target.value)} aria-label="Theme">{THEMES.map(t=><option key={t.id} value={t.id}>{t.label}</option>)}</select>;
}
