import { useMemo } from "react";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import {
  CoinbaseWalletAdapter,
  TrustWalletAdapter,
  LedgerWalletAdapter,
  TorusWalletAdapter,
} from "@solana/wallet-adapter-wallets";
import "@solana/wallet-adapter-react-ui/styles.css";
import { AuthProvider } from "./context/AuthContext";
import { Layout } from "./components/Layout";
import { ProtectedRoute } from "./components/ProtectedRoute";
import { Signup } from "./pages/Signup";
import { Login } from "./pages/Login";
import { Startups } from "./pages/Startups";
import { StartupDetail } from "./pages/StartupDetail";
import { Build } from "./pages/Build";
import { Portfolio } from "./pages/Portfolio";
import Landing from "./pages/Landing";
import { getSolanaConnectionEndpoint } from "./lib/solanaRpc";

const SOLANA_RPC = getSolanaConnectionEndpoint();

function App() {
  // Phantom / Solflare are injected via Wallet Standard — listing legacy adapters too
  // duplicates them and can cause WalletSendTransactionError("Internal error") on send.
  const wallets = useMemo(
    () => [
      new CoinbaseWalletAdapter(),
      new TrustWalletAdapter(),
      new LedgerWalletAdapter(),
      new TorusWalletAdapter(),
    ],
    []
  );

  return (
    <ConnectionProvider endpoint={SOLANA_RPC}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>
          <AuthProvider>
            <BrowserRouter>
              <Routes>
                <Route path="/" element={<Landing />} />
                <Route path="/landing" element={<Landing />} />
                <Route path="/signup" element={<Signup />} />
                <Route path="/login" element={<Login />} />
                <Route path="/app" element={<Layout />}>
                  <Route index element={<Navigate to="/app/startups" replace />} />
                  <Route path="startups" element={<Startups />} />
                  <Route path="startup/:id" element={<StartupDetail />} />
                  <Route
                    path="build"
                    element={
                      <ProtectedRoute>
                        <Build />
                      </ProtectedRoute>
                    }
                  />
                  <Route
                    path="portfolio"
                    element={
                      <ProtectedRoute>
                        <Portfolio />
                      </ProtectedRoute>
                    }
                  />
                </Route>
                <Route path="*" element={<Navigate to="/" replace />} />
              </Routes>
            </BrowserRouter>
          </AuthProvider>
        </WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}

export default App;
