import typography from "@tailwindcss/typography";

/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        // Apple iOS Core System Colors
        "hushh-blue": "#0066CC",          // iOS System Blue — links, buttons, active states
        "ios-green": "#34C759",           // iOS System Green — success, verified
        "ios-yellow": "#FFD60A",          // iOS System Yellow — warnings, highlights
        "ios-red": "#FF3B30",             // iOS System Red — errors, destructive
        "ios-pink": "#FF2D55",            // iOS System Pink — music, photos accent
        "ios-gray-bg": "#F5F5F7",         // Athens Gray — card backgrounds
        "ios-dark": "#1D1D1F",            // Shark — dark surfaces, Fund A card
        "hushh-text-muted": "#6B7280",
      },
      fontFamily: {
        display: ['"Playfair Display"', 'serif'],
        serif: ['"Playfair Display"', 'serif'],
        sans: ['"Manrope"', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'monospace'],
      },
      boxShadow: {
        'soft': '0 8px 30px -4px rgba(0, 0, 0, 0.04)',
      },
      letterSpacing: {
        'widest-xl': '0.2em',
      },
      animation: {
        'pulse-slow': 'pulse 3s cubic-bezier(0.4, 0, 0.6, 1) infinite',
        'fadeIn': 'fadeIn 0.2s ease-out',
        'scaleIn': 'scaleIn 0.3s ease-out',
      },
      keyframes: {
        fadeIn: {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        scaleIn: {
          '0%': { opacity: '0', transform: 'scale(0.95)' },
          '100%': { opacity: '1', transform: 'scale(1)' },
        },
      },
    },
  },
  plugins: [
    // The `prose` classes used by the community article body and the deck reader were inert until
    // now — `prose`, `prose-neutral` and every `prose-h4:` modifier resolved to nothing, so long-form
    // content rendered as unstyled HTML: 16px headings at normal weight, no list markers, no table
    // borders. This is the plugin those classes were written against.
    typography,
  ],
}
