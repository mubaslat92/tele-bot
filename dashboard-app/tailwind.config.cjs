/**** Tailwind config ****/
/**** Uses class-based dark mode for explicit control ****/
module.exports = {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: '#0b1020',
        card: '#0e1733',
        border: '#222a44',
        text: '#E6EDF3',
        accent: '#7dd3fc',
      }
    },
  },
  plugins: [],
}
