const express = require('express');
const exphbs = require('express-handlebars');
const path = require('path');
const { env } = require('process');
// init app
const app = express();

// setup view engine
var hbs = exphbs.create({
    defaultLayout: 'main',
    layoutsDir: path.join(__dirname,'/views/layouts'),
});
app.engine('handlebars',hbs.engine);
app.set('view engine','handlebars');

// environment variable for port
const port = process.env.PORT || 3000;

app.get('/', (req,res) => {
    res.render('home',{
        title: 'Home'
    });
});

app.get('/about',(req,res) => {
    res.render('about',{
        title:'About'
    });
});

app.get('/contact',(req,res) => {
    res.render('contact',{
        title:'Contact'
    });
});

app.listen(port,() => {
    console.log('Server is running on port ' + port);
});