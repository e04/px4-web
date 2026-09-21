import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { MantineProvider, createTheme } from '@mantine/core';
import '@mantine/core/styles.css';
import '@fontsource/roboto-mono/latin-500.css';
import './app/global.css';
import App from './app/App';

const theme = createTheme({
  defaultRadius: 'xs',
  radius: { xs: '2px', sm: '2px', md: '2px', lg: '2px', xl: '2px' },
  fontFamily: '"Noto Sans JP", sans-serif',
  fontFamilyMonospace: '"Roboto Mono", monospace',
  headings: { fontFamily: '"Noto Sans JP", sans-serif' },
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <MantineProvider defaultColorScheme="dark" theme={theme}>
      <App />
    </MantineProvider>
  </StrictMode>,
);
