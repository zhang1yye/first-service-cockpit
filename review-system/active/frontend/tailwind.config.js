/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      height: { 18: '72px' },
      boxShadow: {
        glow: '0 0 22px rgba(37, 99, 235, 0.22)',
        cyan: '0 0 18px rgba(34, 211, 238, 0.35)'
      },
      backgroundImage: {
        grid: 'linear-gradient(rgba(59,130,246,.08) 1px, transparent 1px), linear-gradient(90deg, rgba(59,130,246,.08) 1px, transparent 1px)'
      }
    }
  },
  plugins: []
}
