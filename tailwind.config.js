/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        charcoal: '#24262B',
        graphite: '#15171B',
        silver: '#D9DCE2',
        platinum: '#EEF0F4',
        red: '#E32636',
        crimson: '#9F1020',
        muted: '#AEB3BC',
      },
      boxShadow: {
        glass: '0 20px 50px rgba(15, 17, 22, 0.45)',
      },
      backgroundImage: {
        'hero-gradient': 'linear-gradient(135deg, #15171B, #24262B, #343740)',
        'action-gradient': 'linear-gradient(135deg, #E32636, #9F1020)',
        'vault-card-gradient': 'linear-gradient(120deg, #343740, #24262B, #555B66)',
        'document-gradient': 'linear-gradient(145deg, #EEF0F4, #D9DCE2, #C7CBD3)',
      },
    },
  },
  plugins: [],
}
