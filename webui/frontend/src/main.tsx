import { createRoot } from 'react-dom/client';
import { createBrowserRouter, RouterProvider } from 'react-router-dom';
import { App } from './App';
import './styles/tailwind.css';

const router = createBrowserRouter([{ path: '/*', element: <App /> }]);
createRoot(document.getElementById('root')!).render(<RouterProvider router={router} />);
