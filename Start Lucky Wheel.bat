@echo off
title Coullseys Lucky Wheel
cd /d "%~dp0"
start "" http://localhost:5730/
node server.js
pause
