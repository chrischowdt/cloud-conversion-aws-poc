import React, { createContext, useContext, useState, type ReactNode } from 'react';

type TokenContextValue = {
  token: string | null;
  setToken: (token: string | null) => void;
};

export const TokenContext = createContext<TokenContextValue>({
  token: null,
  setToken: () => undefined,
});

export const TokenProvider = ({ children }: { children: ReactNode }) => {
  const [token, setToken] = useState<string | null>(null);
  return (
    <TokenContext.Provider value={{ token, setToken }}>
      {children}
    </TokenContext.Provider>
  );
};

export const useToken = () => useContext(TokenContext);
