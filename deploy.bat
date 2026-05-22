@echo off
echo Deploying to Cloudflare...
node --use-system-ca -e "require('child_process').execSync('npx wrangler pages deploy . --project-name=inflictor --commit-dirty=true --branch=main', {stdio:'inherit', env:{...process.env}})"
echo.
echo Done!
pause
