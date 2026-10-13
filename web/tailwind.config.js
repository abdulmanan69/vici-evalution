/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: '#F6F7F9',
        surface: '#FFFFFF',
        ink: {
          DEFAULT: '#16181D',
          2: '#5A6372',
          3: '#8A93A3',
        },
        brand: {
          DEFAULT: '#3B4A9F',
          dark: '#2F3C85',
          soft: '#EDEFF9',
        },
        amber: {
          line: '#C97A10',
          soft: '#FBF3E4',
        },
        good: { DEFAULT: '#1F7A4D', soft: '#E8F4EE' },
        bad: { DEFAULT: '#B3362C', soft: '#FAECEA' },
        info: { DEFAULT: '#2B6CB0', soft: '#EAF2FA' },
      },
      fontFamily: {
        display: ['"Space Grotesk"', 'Inter', 'system-ui', 'sans-serif'],
        sans: ['Inter', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'SFMono-Regular', 'monospace'],
      },
      fontSize: {
        '2xs': ['0.6875rem', { lineHeight: '1rem' }],
      },
      boxShadow: {
        card: '0 1px 2px rgba(22,24,29,0.05), 0 0 0 1px rgba(22,24,29,0.06)',
      },
    },
  },
  plugins: [],
};
