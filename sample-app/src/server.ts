import { app } from './app.js';

const port = process.env.PORT ?? 3000;

app.listen(port, () => {
  console.log(`Sample application listening on port ${port}`);
});
