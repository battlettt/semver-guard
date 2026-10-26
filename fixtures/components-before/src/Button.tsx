import { iconFor } from './icons.js';

type ButtonProps = {
  label: string;
  variant: 'primary' | 'secondary';
};

function className(variant: ButtonProps['variant']): string {
  return `btn btn-${variant}`;
}

export function Button(props: ButtonProps) {
  return (
    <button className={className(props.variant)}>
      {iconFor(props.variant)}
      {props.label}
    </button>
  );
}
