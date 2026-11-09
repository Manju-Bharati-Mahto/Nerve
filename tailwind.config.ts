import type { Config } from "tailwindcss";
import tailwindcssAnimate from "tailwindcss-animate";

export default {
  darkMode: ["class"],
  content: ["./pages/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}", "./app/**/*.{ts,tsx}", "./src/**/*.{ts,tsx}"],
  prefix: "",
  theme: {
    container: {
      center: true,
      padding: "2rem",
      screens: {
        "2xl": "1400px",
      },
    },
    extend: {
      colors: {
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        primary: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(var(--primary-foreground))",
        },
        secondary: {
          DEFAULT: "hsl(var(--secondary))",
          foreground: "hsl(var(--secondary-foreground))",
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive))",
          foreground: "hsl(var(--destructive-foreground))",
        },
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))",
        },
        accent: {
          DEFAULT: "hsl(var(--accent))",
          foreground: "hsl(var(--accent-foreground))",
        },
        popover: {
          DEFAULT: "hsl(var(--popover))",
          foreground: "hsl(var(--popover-foreground))",
        },
        card: {
          DEFAULT: "hsl(var(--card))",
          foreground: "hsl(var(--card-foreground))",
        },
        brand: {
          DEFAULT: "hsl(var(--brand))",
          light: "hsl(var(--brand-light))",
          dark: "hsl(var(--brand-dark))",
        },
        /* ── Branding-portal accent ramp ────────────────────────────────
           The one place to change the branding dashboard's colour. Kept
           separate from `brand` above (which drives --primary for the WHOLE
           app) so recolouring this portal cannot repaint the design or media
           portals. Mirrored as --bp-*-rgb in src/index.css. */
        bp: {
          50:  "rgb(var(--bp-50-rgb) / <alpha-value>)",
          100: "rgb(var(--bp-100-rgb) / <alpha-value>)",
          200: "rgb(var(--bp-200-rgb) / <alpha-value>)",
          300: "rgb(var(--bp-300-rgb) / <alpha-value>)",
          400: "rgb(var(--bp-400-rgb) / <alpha-value>)",
          500: "rgb(var(--bp-500-rgb) / <alpha-value>)",
          600: "rgb(var(--bp-600-rgb) / <alpha-value>)",
          700: "rgb(var(--bp-700-rgb) / <alpha-value>)",
          800: "rgb(var(--bp-800-rgb) / <alpha-value>)",
          900: "rgb(var(--bp-900-rgb) / <alpha-value>)",
        },
        /* ── Kravio design system (branding user dashboard) ───────────── */
        kv: {
          canvas: "#F5F6F8",
          side: "#FAFBFC",
          surface: "#FFFFFF",
          field: "#F9FAFB",
          line: "#E5E7EB",
          line2: "#D1D5DB",
          ink: "#111827",
          ink2: "#374151",
          muted: "#6B7280",
          faint: "#9CA3AF",
          ghost: "#D1D5DB",
          navy: "#0F172A",
          navy2: "#1E293B",
          bar: "#E5E7EB",
          bar2: "#EEF0F3",
          pos: "#16A34A",
          posbg: "#DCFCE7",
          neg: "#DC2626",
          negbg: "#FEE2E2",
          warn: "#F59E0B",
          warnbg: "#FEF3C7",
          info: "#2563EB",
          infobg: "#DBEAFE",
          violet: "#7C3AED",
          violetbg: "#EDE9FE",
          teal: "#0D9488",
          tealbg: "#CCFBF1",
        },
        sidebar: {
          DEFAULT: "hsl(var(--sidebar-background))",
          foreground: "hsl(var(--sidebar-foreground))",
          primary: "hsl(var(--sidebar-primary))",
          "primary-foreground": "hsl(var(--sidebar-primary-foreground))",
          accent: "hsl(var(--sidebar-accent))",
          "accent-foreground": "hsl(var(--sidebar-accent-foreground))",
          border: "hsl(var(--sidebar-border))",
          ring: "hsl(var(--sidebar-ring))",
        },
      },
      fontFamily: {
        inter: ['Inter', 'system-ui', 'sans-serif'],
        sans: ['"DM Sans"', 'system-ui', 'sans-serif'],
        serif: ['"DM Serif Display"', 'Georgia', 'serif'],
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
      },
      keyframes: {
        "accordion-down": {
          from: { height: "0" },
          to: { height: "var(--radix-accordion-content-height)" },
        },
        "accordion-up": {
          from: { height: "var(--radix-accordion-content-height)" },
          to: { height: "0" },
        },
        "fade-in": {
          from: { opacity: "0", transform: "translateY(8px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
        "scale-in": {
          from: { opacity: "0", transform: "scale(0.96) translateY(-4px)" },
          to: { opacity: "1", transform: "scale(1) translateY(0)" },
        },
      },
      animation: {
        "accordion-down": "accordion-down 0.2s ease-out",
        "accordion-up": "accordion-up 0.2s ease-out",
        "fade-in": "fade-in 0.3s ease-out",
        "scale-in": "scale-in 0.16s ease-out",
      },
    },
  },
  plugins: [tailwindcssAnimate],
} satisfies Config;
