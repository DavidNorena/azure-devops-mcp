// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import express from "express";
import cors from "cors";
import { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { JSONRPCMessage, JSONRPCRequest } from "@modelcontextprotocol/sdk/types.js";
import { packageVersion } from "./version.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

interface McpSessionHeaders {
  'mcp-session-id'?: string;
}

interface PendingRequest {
  resolve: (value: JSONRPCMessage) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

class HttpMcpTransport implements Transport {
  private pendingRequests = new Map<string | number, PendingRequest>();
  private messageHandler?: (message: JSONRPCMessage) => void;

  async start(): Promise<void> {
    // Transport is ready
  }

  async send(message: JSONRPCMessage): Promise<void> {
    if ('id' in message && message.id !== undefined) {
      const pending = this.pendingRequests.get(message.id);
      if (pending) {
        clearTimeout(pending.timeout);
        this.pendingRequests.delete(message.id);
        pending.resolve(message);
      }
    }
  }

  async close(): Promise<void> {
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timeout);
      pending.reject(new Error(`Transport closed ${id}`));
    }
    this.pendingRequests.clear();
  }

  async handleRequest(request: JSONRPCRequest): Promise<JSONRPCMessage | null> {
    if (!('id' in request) || request.id === undefined) {
      if (this.messageHandler) {
        this.messageHandler(request);
      }
      return null;
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(request.id);
        reject(new Error('Request timeout'));
      }, 30000);

      this.pendingRequests.set(request.id, { resolve, reject, timeout });

      if (this.messageHandler) {
        this.messageHandler(request);
      } else {
        reject(new Error('No message handler available'));
      }
    });
  }

  set onmessage(handler: ((message: JSONRPCMessage) => void) | undefined) {
    this.messageHandler = handler;
  }

  get onmessage(): ((message: JSONRPCMessage) => void) | undefined {
    return this.messageHandler;
  }

  onclose?: () => void;
  onerror?: (error: Error) => void;
}

export function configureHttpTransport(server: McpServer, orgName: string): import('http').Server {
  const port = parseInt(process.env.PORT || "3000");
  const host = process.env.HOST || "localhost";
  
  const app = express();
  let sessionId: string | null = null;
  let transport: HttpMcpTransport | null = null;
  let isInitialized = false;

  app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'OPTIONS', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Mcp-Session-Id', 'Last-Event-ID'],
  }));

  app.use(express.json());

  const initializeTransport = async (): Promise<void> => {
    if (!transport) {
      transport = new HttpMcpTransport();
      await server.connect(transport);
    }
  };

  app.get('/health', (req: express.Request, res: express.Response) => {
    res.json({ 
      status: 'healthy', 
      service: 'Azure DevOps MCP Server', 
      version: packageVersion,
      sessionActive: sessionId !== null,
      transportConnected: transport !== null,
      initialized: isInitialized
    });
  });

  app.get('/info', (req: express.Request, res: express.Response) => {
    res.json({
      name: 'Azure DevOps MCP Server',
      version: packageVersion,
      organization: orgName,
      endpoints: {
        mcp: '/mcp',
        health: '/health',
        info: '/info'
      }
    });
  });

  app.post('/mcp', async (req: express.Request, res: express.Response) => {
    try {
      const requestBody = req.body as JSONRPCRequest;
      
      await initializeTransport();
      
      if (!transport) {
        throw new Error('Transport not initialized');
      }

      if (requestBody?.method === 'initialize' && !sessionId) {
        sessionId = `session-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
        res.setHeader('Mcp-Session-Id', sessionId);
      }
      
      const response = await transport.handleRequest(requestBody);
      
      if (requestBody?.method === 'initialize' && response && 'result' in response) {
        isInitialized = true;
      }
      
      if (response !== null) {
        res.setHeader('Content-Type', 'application/json');
        res.json(response);
      } else {
        res.status(200).end();
      }
      
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      const requestId = (req.body as JSONRPCRequest)?.id;
      
      const errorResponse = {
        jsonrpc: "2.0" as const,
        id: requestId ?? null,
        error: {
          code: -32603,
          message: "Internal error",
          data: errorMessage
        }
      };
      
      res.status(500).json(errorResponse);
    }
  });

  app.delete('/mcp', (req: express.Request, res: express.Response) => {
    const headers = req.headers as McpSessionHeaders;
    const requestSessionId = headers['mcp-session-id'];
    
    if (requestSessionId === sessionId) {
      sessionId = null;
      isInitialized = false;
      res.status(200).json({ message: 'Session terminated' });
    } else {
      res.status(404).json({ error: 'Session not found' });
    }
  });

  const httpServer = app.listen(port, host, () => {
    console.log(`Azure DevOps MCP Server running at http://${host}:${port}`);
    console.log(`Organization: ${orgName}`);
    console.log(`MCP endpoint: http://${host}:${port}/mcp`);
    console.log(`Health check: http://${host}:${port}/health`);
  });

  const shutdown = (): void => {
    console.log('Shutting down gracefully...');
    if (transport) {
      transport.close();
    }
    httpServer.close(() => {
      console.log('HTTP server closed');
      process.exit(0);
    });
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  return httpServer;
}
