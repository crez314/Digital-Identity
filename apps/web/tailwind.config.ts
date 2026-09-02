import type { Config } from 'tailwindcss';

export default {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        pass: '#16a34a',
        warn: '#d97706',
        fail: '#dc2626',
        review: '#7c3aed',
      },
    },
  },
  plugins: [],
} satisfies Config;
