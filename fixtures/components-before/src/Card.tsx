export interface Theme {
  background: string;
  foreground: string;
}

interface CardProps {
  title: string;
  theme?: Theme;
}

export const Card = ({ title, theme }: CardProps) => (
  <section style={{ background: theme?.background, color: theme?.foreground }}>
    <h2>{title}</h2>
  </section>
);
