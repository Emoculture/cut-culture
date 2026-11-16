import { useState } from 'react'
import { ArrowUpRight, Menu, X } from 'lucide-react'
export const links = [['Услуги', '#services'], ['Мастера', '#team'], ['Работы', '#works'], ['О нас', '#about'], ['Контакты', '#contacts']]
export default function Header({ onBook }: { onBook: () => void }) {
  const [expanded, setExpanded] = useState(false)
  return <header className="header"><a className="logo" href="#home" aria-label="CUT CULTURE — на главную">CUT CULTURE<span>BARBERSHOP • EST. 2024</span></a><nav id="navigation" className={expanded ? 'navigation expanded' : 'navigation'} aria-label="Главная навигация">{links.map(([title, href]) => <a key={href} href={href} onClick={() => setExpanded(false)}>{title}</a>)}</nav><button className="header-book" onClick={onBook}>Записаться <ArrowUpRight size={16}/></button><button className="icon-button menu-toggle" aria-label={expanded ? 'Закрыть меню' : 'Открыть меню'} aria-expanded={expanded} aria-controls="navigation" onClick={() => setExpanded(!expanded)}>{expanded ? <X/> : <Menu/>}</button></header>
}
