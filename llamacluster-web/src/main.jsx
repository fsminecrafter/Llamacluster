import React from 'react';import {createRoot} from 'react-dom/client';import {BrowserRouter,Routes,Route} from 'react-router-dom';
import {ThemeProvider} from './theme.jsx';import Dashboard from './pages/Dashboard.jsx';import Chat from './pages/Chat.jsx';import './styles.css';
createRoot(document.getElementById('root')).render(<ThemeProvider><BrowserRouter><Routes>
<Route path="/" element={<Dashboard/>}/><Route path="/chat" element={<Chat/>}/><Route path="*" element={<Dashboard/>}/></Routes></BrowserRouter></ThemeProvider>);
