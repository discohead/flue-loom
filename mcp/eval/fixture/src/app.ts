import { createAgentRouter } from '@flue/runtime/routing';
import { Hono } from 'hono';
import { bearerAuth } from 'hono/bearer-auth';
import { Broken } from './agents/broken.ts';
import { Calc } from './agents/calc.ts';
import { Counter } from './agents/counter.ts';
import { Echo } from './agents/echo.ts';
import { Inbox } from './agents/inbox.ts';
import { Profile } from './agents/profile.ts';
import { Slow } from './agents/slow.ts';
import { Vault } from './agents/vault.ts';

const app = new Hono();

app.route('/agents/echo', createAgentRouter(Echo));
app.route('/agents/calc', createAgentRouter(Calc));
app.route('/agents/counter', createAgentRouter(Counter));
app.route('/agents/slow', createAgentRouter(Slow));
app.route('/agents/profile', createAgentRouter(Profile));
app.route('/agents/inbox', createAgentRouter(Inbox));
app.route('/agents/broken', createAgentRouter(Broken));

// Protected mount: callers need `Authorization: Bearer <VAULT_TOKEN>`.
app.use('/secure/*', bearerAuth({ token: process.env.VAULT_TOKEN ?? 'open-sesame' }));
app.route('/secure/vault', createAgentRouter(Vault));

export default app;
