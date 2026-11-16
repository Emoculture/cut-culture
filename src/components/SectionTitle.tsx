import type { ReactNode } from 'react'
export default function SectionTitle({ number, label, title, children }: { number: string; label: string; title: string; children?: ReactNode }) {
 return <div className="section-heading reveal"><div><span className="eyebrow"><span className="section-number">{number} /</span> {label}</span><h2>{title}</h2></div>{children}</div>
}
