/**
 * The Nerve lockups, rendered inline so the mark follows the primary colour
 * the user picks with the paintbrush. An <img> cannot read CSS variables;
 * inlining the SVG lets the two parallelograms use `--nerve-primary` (the
 * front shape) and the lighter `--bp-400` (the back shape), while the
 * wordmark switches between navy and off-white with the colour mode.
 *
 *   <BrandLogo variant="nerve" />   Nerve · powered by Parul University (sidebars)
 *   <BrandLogo variant="parul" />   Parul University | Nerve (login page)
 */
import nerveRaw from '@/assets/nerve1.svg?raw'
import parulRaw from '@/assets/parul-logo.svg?raw'

const MARK_FRONT = /#2A0EFA/gi
const MARK_BACK = /#706EFD/gi
const WORDMARK = /#1B1F54/gi
const BLACK = /(fill|stroke)="black"/g

function themed(svg: string): string {
  return svg
    .replace(MARK_FRONT, 'var(--nerve-primary)')
    .replace(MARK_BACK, 'var(--bp-400)')
    // Navy on white, near-white in dark mode (index.css / dark.css).
    .replace(WORDMARK, 'var(--nv-wordmark, #1B1F54)')
    .replace(BLACK, '$1="var(--nv-wordmark, #000000)"')
    // Let the wrapper size it; the file's own width/height are the viewBox's.
    .replace(/<svg([^>]*?)\swidth="[^"]*"/, '<svg$1')
    .replace(/<svg([^>]*?)\sheight="[^"]*"/, '<svg$1')
}

const SOURCES = {
  nerve: themed(nerveRaw),
  parul: themed(parulRaw),
} as const

export default function BrandLogo({ variant = 'nerve', className = '', alt }: {
  variant?: keyof typeof SOURCES
  className?: string
  alt?: string
}) {
  return (
    <span
      role="img"
      aria-label={alt ?? (variant === 'parul' ? 'Parul University · Nerve' : 'Nerve · Powered by Parul University')}
      className={`inline-block select-none [&>svg]:block [&>svg]:w-full [&>svg]:h-auto ${className}`}
      dangerouslySetInnerHTML={{ __html: SOURCES[variant] }}
    />
  )
}
