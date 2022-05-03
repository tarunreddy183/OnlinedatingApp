const express = require('express');
const exphbs = require('express-handlebars');
const path = require('path');
const { env } = require('process');
const bodyparser = require('body-parser');
const mongoose = require('mongoose');
const passport = require('passport');
const cookieParser = require('cookie-parser');
const session = require('express-session');
const Handlebars = require('handlebars');
const { allowInsecurePrototypeAccess } = require('@handlebars/allow-prototype-access');
const flash = require('connect-flash');
const bcrypt = require('bcryptjs');
const formidable = require('formidable');

// Load models
const Message = require('./models/message');
// init app
const app = express();
// Load keys file
const keys = require('./config/keys');
const User = require('./models/user');
const Chat = require('./models/chat');
const Smile = require('./models/smile');
const Post = require('./models/post');

// load stripe module
const stripe = require('stripe')(keys.StripeSecretkey);

// Load helpers
const {requireLogin,ensureGuest} = require('./helpers/auth');
const {uploadImage} = require('./helpers/aws');
const {getLastMoment} = require('./helpers/moment');
const {walletChecker} = require('./helpers/wallet');
const { AppConfig } = require('aws-sdk');
// use body-parser
app.use(bodyparser.urlencoded({extended:false}));
app.use(bodyparser.json());
// configuration for authentication
app.use(cookieParser());
app.use(session({
    secret: 'mysecret',
    resave: true,
    saveUninitialized: true
}));
app.use(passport.initialize());
app.use(passport.session());
app.use(flash());
app.use((req,res,next) => {
    res.locals.success_msg = req.flash('success_msg');
    res.locals.error_msg = req.flash('error_msg');
    res.locals.error = req.flash('error');
    next();
});

// setup express static folder to server js, css files
app.use(express.static('public'));
// Make user global object
app.use((req,res, next) => {
    res.locals.user = req.user || null;
    next();
});
// load facebook strategy
require('./passport/facebook');
require('./passport/google');
require('./passport/local');

// connect to mLab MongoDB
mongoose.connect(keys.MongoDB,{useNewUrlParser:true}).then(() => {
    console.log('Server is connected to MongoDB');
}).catch((err) => {
    console.log(err);
});

// setup view engine
var hbs = exphbs.create({
    defaultLayout: 'main',
    layoutsDir: path.join(__dirname,'/views/layouts'),
});
app.engine('handlebars',exphbs({
    defaultLayout:'main',
    helpers: {
        getLastMoment:getLastMoment
    },
handlebars: allowInsecurePrototypeAccess(Handlebars)}));
app.set('view engine','handlebars');

// environment variable for port
const port = process.env.PORT || 3000;

app.get('/', ensureGuest,(req,res) => {
    res.render('home',{
        title: 'Welcome'
    });
});

app.get('/about',ensureGuest,(req,res) => {
    res.render('about',{
        title:'About'
    });
});

app.get('/contact',ensureGuest,(req,res) => {
    res.render('contact',{
        title:'Contact'
    });
});

app.get('/auth/facebook',passport.authenticate('facebook',{
    scope: ['email']
}));
app.get('/auth/facebook/callback',passport.authenticate('facebook',{
    successRedirect: '/profile',
    failureRedirect: '/'
}));

app.get('/auth/google',passport.authenticate('google',{
    scope: ['profile']
}));
app.get('/auth/google/callback',passport.authenticate('google',{
    successRedirect: '/profile',
    failureRedirect: '/'
}));

app.get('/profile',requireLogin,(req,res) => {
    User.findById({_id:req.user._id}).then((user) => {
        if (user) {
            user.online = true;
            user.save((err,user) => {
                if(err) {
                    throw err;
                }else{
                    Smile.findOne({receiver:req.user._id,receiverReceived:false})
                    .then((newSmile) => {
                        Chat.findOne({$or:[
                            {receiver:req.user._id,receiverRead:false},
                            {sender:req.user._id,senderRead:false}
                        ]})
                        .then((unread) => {
                           Post.find({postUser:req.user._id})
                           .populate('postUser')
                           .sort({date:'desc'})
                           .then((posts) => {
                               if (posts) {
                                  res.render('profile',{
                                      title: 'Profile',
                                      user: user,
                                      newSmile: newSmile,
                                      unread:unread,
                                      posts:posts
                                    });
                               }else{
                                   console.log('User does not have any posts');
                                   res.render('profile',{
                                       title: 'Profile',
                                       user: user,
                                       newSmile: newSmile,
                                       unread:unread
                                    });
                               }
                           })
                        })
                    })
                }
            })
        } 
    });
});
app.post('/updateProfile',requireLogin,(req,res) => {
    User.findById({_id:req.user._id})
    .then((user) => {
        user.fullname = req.body.fullname;
        user.email = req.body.email;
        user.gender = req.body.gender;
        user.about = req.body.about;
        user.save(() => {
            res.redirect('/profile');
        });
    });
});

app.get('/askToDelete',requireLogin,(req,res) => {
    res.render('askToDelete',{
        title: 'Delete'
    });
});

app.get('/deleteAccount',requireLogin,(req,res) => {
    User.deleteOne({_id:req.user._id})
    .then(() => {
        res.render('accountDeleted',{
            title:'Deleted'
        });
    });
});

app.get('/newAccount',(req,res) => {
    res.render('newAccount',{
        title: 'Signup'
    });
});

app.post('/signup',(req,res) => {
    //console.log(req.body);
    let errors = [];

    if (req.body.password !== req.body.password2) {
        errors.push({text:'Password does not match'});
    }
    if (req.body.password.length < 5) {
        errors.push({text:'Password must be atleast 5 characters'});
    }
    if (errors.length > 0) {
        res.render('newAccount',{
            errors: errors,
            title: 'Error',
            fullname: req.body.username,
            email: req.body.email,
            password: req.body.password,
            password2: req.body.password2
        });
    }else{
        User.findOne({email:req.body.email})
        .then((user) => {
           if (user) {
              let errors = [];
              errors.push({text:'Email already exist'});
              res.render('newAccount',{
                title:'Signup',
                errors:errors
              });
           }else{
               var salt = bcrypt.genSaltSync(10);
               var hash = bcrypt.hashSync(req.body.password,salt);
               const newUser = {
                   fullname: req.body.username,
                   email: req.body.email,
                   password: hash
               }
               new User(newUser).save((err,user) => {
                   if (err) {
                       throw err;
                   }
                   if (user) {
                       let success = [];
                       success.push({text:'You have successfully created new account. You can login now'});
                       res.render('home',{
                           success:success
                       });
                   }
               });
           }
        });
    }
});
app.post('/login',passport.authenticate('local',{
    successRedirect: '/profile',
    failureRedirect: '/loginErrors'
}));
app.get('/loginErrors', (req,res) => {
    let errors = [];
    errors.push({text:'User Not Found or Password Incorrect'});
    res.render('home',{
        errors:errors
    });
});
// retrieve password process
app.get('/retrievePwd',(req,res) => {
    res.render('retrievePwd',{
        title: 'Retrieve'
    })
})
app.post('/retrievePwd',(req,res) => {
    let email = req.body.email.trim();
    let pwd1 = req.body.password.trim();
    let pwd2 = req.body.password2.trim();

    if (pwd1 !== pwd2) {
        res.render('pwdDoesNotMatch',{
            title:'Not match'
        })
    }

    User.findOne({email:email})
    .then((user) => {
        let salt = bcrypt.genSaltSync(10);
        let hash = bcrypt.hashSync(pwd1,salt);

        user.password = hash;
        user.save((err,user) => {
            if (err) {
                throw err;
            }
            if (user) {
                res.render('pwdUpdated',{
                    title:'Updated'
                })
            }
        })
    })
})
// handle get route
app.get('/uploadImage',requireLogin,(req,res) => {
    res.render('uploadImage',{
        title: 'Upload'
    });
});
app.post('/uploadAvatar',requireLogin,(req,res) => {
    User.findById({_id:req.user._id})
    .then((user) => {
        user.image = `https://online-dating-app.s3.ap-south-1.amazonaws.com/${req.body.upload}`;
        user.save((err) => {
            if (err) {
                throw err;
            }
            else{
                res.redirect('/profile');
            }
        });
    });
});

app.post('/uploadFile',requireLogin,uploadImage.any(),(req,res) => {
    const form = new formidable.IncomingForm();
    form.on('file',(field,file) => {
        console.log(file);
    });
    form.on('error',(err) => {
        console.log(err);
    });
    form.on('end',() => {
        console.log('Image upload is successful ...');
    });
    form.parse(req);
});

// handle Get route for users
app.get('/singles',requireLogin,(req,res) => {
    User.find({})
    .sort({date:'desc'})
    .then((singles) => {
        res.render('singles',{
            title:'Singles',
            singles:singles
        })
    }).catch((err) => {
        console.log(err);
    });
});

app.get('/userProfile/:id',requireLogin,(req,res) => {
    User.findById({_id:req.params.id})
    .then((user) => {
        Smile.findOne({receiver:req.params.id})
        .then((smile) => {
           Post.find({status:'public',postUser:user._id})
           .populate('postUser')
           .populate('comments.commentUser')
           .populate('likes.likeUser')
           .then((publicPosts) => {
               res.render('userProfile',{
                   title:'Profile',
                   oneUser: user,
                   smile:smile,
                   publicPosts:publicPosts
               });
           })
        })
    });
});
// START CHAT PROCESS
app.get('/startChat/:id',requireLogin,(req,res) => {
    Chat.findOne({sender:req.params.id,receiver:req.user._id})
    .then((chat) => {
        if (chat) {
            chat.receiverRead = true;
            chat.senderRead = false;
            chat.save((err,chat) => {
                if (err) {
                    throw err;
                }
                if (chat) {
                    res.redirect(`/chat/${chat._id}`);
                }
            })
        }else{
            Chat.findOne({sender:req.user._id,receiver:req.params.id})
            .then((chat) => {
                if (chat) {
                    chat.senderRead = true;
                    chat.reciverRead = false;
                    chat.date = new Date();
                    chat.save((err,chat) => {
                        if (err) {
                            throw err;
                        }
                        if (chat) {
                            res.redirect(`/chat/${chat._id}`);
                        }
                    })
                }else{
                    const newChat = {
                        sender: req.user._id,
                        receiver: req.params.id,
                        senderRead: true,
                        receiverRead: false,
                        date: new Date()
                    }
                    new Chat(newChat).save((err,chat) => {
                        if (err) {
                            throw err;
                        }
                        if (chat) {
                            res.redirect(`/chat/${chat._id}`);
                        }
                    })
                }
            })
        }
    })
})
// Display Chat Room
app.get('/chat/:id([0-9a-f]{24})',requireLogin,(req,res) => {
    Chat.findById({_id:req.params.id})
    .populate('sender')
    .populate('receiver')
    .populate('chats.senderName')
    .populate('chats.receiverName')
    .then((chat) => {
        User.findOne({_id:req.user._id})
        .then((user) => {
            res.render('chatRoom',{
                title: 'Chat',
                user:user,
                chat:chat
            })
        })
    })
})
app.post('/chat/:id([0-9a-f]{24})',requireLogin,walletChecker,(req,res) => {
    Chat.findOne({_id:req.params.id,sender:req.user._id})
    .sort({date:'desc'})
    .populate('sender')
    .populate('receiver')
    .populate('chats.senderName')
    .populate('chats.receiverName')
    .then((chat) => {
        if (chat) {
            // sender sends message
            chat.senderRead = true;
            chat.receiverRead = false;
            chat.date = new Date();

            const newChat = {
                senderName:req.user._id,
                senderRead: true,
                receiverName: chat.receiver._id,
                receiverRead: false,
                date: new Date(),
                senderMessage: req.body.chat
            }
            chat.chats.push(newChat)
            chat.save((err,chat) => {
                if (err) {
                    throw err;
                }
                if (chat) {
                    Chat.findOne({_id:chat._id})
                    .sort({date:'desc'})
                    .populate('sender')
                    .populate('receiver')
                    .populate('chats.senderName')
                    .populate('chats.receiverName')
                    .then((chat) => {
                        User.findById({_id:req.user._id})
                        .then((user) => {
                            // we will charge client for each message
                            user.wallet = user.wallet - 1;
                            user.save((err,user) => {
                                if (err) {
                                    throw err;
                                }
                                if (user) {
                                    res.render('chatRoom',{
                                        title:'Chat',
                                        chat:chat,
                                        user:user
                                    })
                                }
                            })
                        })
                    })
                }
            })
        }
        // receiver sends message back
        else{
            Chat.findOne({_id:req.params.id,receiver:req.user._id})
            .sort({date:'desc'})
            .populate('sender')
            .populate('receiver')
            .populate('chats.senderName')
            .populate('chats.receiverName')
            .then((chat) => {
                chat.senderRead = true;
                chat.reciverRead = false;
                chat.date = new Date();
                const newChat = {
                    senderName: chat.sender._id,
                    senderRead: false,
                    receiverName: req.user._id,
                    reciverRead: true,
                    receiverMessage: req.body.chat,
                    date: new Date()
                }
                chat.chats.push(newChat)
                chat.save((err,chat) => {
                    if (err) {
                        throw err;
                    }
                    if (chat) {
                        Chat.findOne({_id:chat._id})
                        .sort({date:'desc'})
                        .populate('sender')
                        .populate('receiver')
                        .populate('chats.senderName')
                        .populate('chats.receiverName')
                        .then((chat) => {
                            User.findById({_id:req.user._id})
                            .then((user) => {
                                user.wallet = user.wallet - 1;
                                user.save((err,user) => {
                                    if (err) {
                                        throw err;
                                    }
                                    if (user) {
                                        res.render('chatRoom',{
                                            title:'Chat',
                                            user:user,
                                            chat:chat
                                        })
                                    }
                                })
                            })
                        })
                    }
                })
            })
        }
    })
})
app.get('/chats',requireLogin,(req,res) => {
    Chat.find({receiver:req.user._id})
    .populate('sender')
    .populate('receiver')
    .populate('chats.senderName')
    .populate('chats.receiverName')
    .sort({date:'desc'})
    .then((received) => {
        Chat.find({sender:req.user._id})
        .populate('sender')
        .populate('receiver')
        .populate('chats.senderName')
        .populate('chats.receiverName')
        .sort({date:'desc'})
        .then((sent) => {
            res.render('chat/chats',{
                title: 'Chat History',
                received:received,
                sent:sent
            })
        })
    })
})
// DELETE CHAT
app.get('/deleteChat/:id',requireLogin,(req,res) => {
    Chat.deleteOne({_id:req.params.id})
    .then(() => {
        res.redirect('/chats');
    });
});
// CHARGE CLIENT
app.post('/charge10dollars',requireLogin,(req,res) => {
    console.log(req.body);
    const amount = 1000;
    stripe.customers.create({
        email:req.body.stripeEmail,
        source: req.body.stripeToken
    }).then((customer) => {
        return stripe.paymentIntents.create({
            amount:1000,
            description: '$10 for 20 messages',
            currency: 'usd',
            payment_method_types:['card'],
            customer:customer.id,
            receipt_email:customer.email
        }).then((charge) => {
            if (charge) {
                User.findById({_id:req.user._id})
                .then((user) => {
                    user.wallet +=20;
                    user.save()
                    .then(() => {
                        res.render('success',{
                            title:'Success',
                            charge:charge
                        })
                    })
                })
            }
        }).catch((err) => {
            console.log(err);
        })
    }).catch((err) => {
        console.log(err);
    })
})
// Charge 20 dollars
app.post('/charge20dollars',requireLogin,(req,res) => {
    console.log(req.body);
    const amount = 2000;
    stripe.customers.create({
        email:req.body.stripeEmail,
        source: req.body.stripeToken
    }).then((customer) => {
        return stripe.paymentIntents.create({
            amount:2000,
            description: '$20 for 50 messages',
            currency: 'usd',
            payment_method_types:['card'],
            customer:customer.id,
            receipt_email:customer.email
        }).then((charge) => {
            if (charge) {
                User.findById({_id:req.user._id})
                .then((user) => {
                    user.wallet +=50;
                    user.save()
                    .then(() => {
                        res.render('success',{
                            title:'Success',
                            charge:charge
                        })
                    })
                })
            }
        }).catch((err) => {
            console.log(err);
        })
    }).catch((err) => {
        console.log(err);
    })
})
// Charge 30 dollars
app.post('/charge30dollars',requireLogin,(req,res) => {
    console.log(req.body);
    const amount = 3000;
    stripe.customers.create({
        email:req.body.stripeEmail,
        source: req.body.stripeToken
    }).then((customer) => {
        return stripe.paymentIntents.create({
            amount:3000,
            description: '$30 for 100 messages',
            currency: 'usd',
            payment_method_types:['card'],
            customer:customer.id,
            receipt_email:customer.email
        }).then((charge) => {
            if (charge) {
                User.findById({_id:req.user._id})
                .then((user) => {
                    user.wallet +=100;
                    user.save()
                    .then(() => {
                        res.render('success',{
                            title:'Success',
                            charge:charge
                        })
                    })
                })
            }
        }).catch((err) => {
            console.log(err);
        })
    }).catch((err) => {
        console.log(err);
    })
})
// Charge 40 dollars
app.post('/charge40dollars',requireLogin,(req,res) => {
    console.log(req.body);
    const amount = 4000;
    stripe.customers.create({
        email:req.body.stripeEmail,
        source: req.body.stripeToken
    }).then((customer) => {
        return stripe.paymentIntents.create({
            amount:4000,
            description: '$40 for 200 messages',
            currency: 'usd',
            payment_method_types:['card'],
            customer:customer.id,
            receipt_email:customer.email
        }).then((charge) => {
            if (charge) {
                User.findById({_id:req.user._id})
                .then((user) => {
                    user.wallet +=200;
                    user.save()
                    .then(() => {
                        res.render('success',{
                            title:'Success',
                            charge:charge
                        })
                    })
                })
            }
        }).catch((err) => {
            console.log(err);
        })
    }).catch((err) => {
        console.log(err);
    })
})
// GET ROUTE TO SEND SMILE
app.get('/sendSmile/:id',requireLogin,(req,res) => {
    const newSmile = {
        sender: req.user._id,
        receiver: req.params.id,
        senderSent: true
    }
    new Smile(newSmile).save((err,smile) => {
        if (err) {
            throw err;
        }
        if (smile) {
            res.redirect(`/userProfile/${req.params.id}`);
        }
    })
})
// DELETE SMILE
app.get('/deleteSmile/:id',requireLogin,(req,res) => {
    Smile.deleteOne({receiver:req.params.id,sender:req.user._id})
    .then(() => {
        res.redirect(`/userProfile/${req.params.id}`);
    })
})
// SHOW SMILE SENDER
app.get('/showSmile/:id',requireLogin,(req,res) => {
    Smile.findOne({_id:req.params.id})
    .populate('sender')
    .populate('receiver')
    .then((smile) => {
        smile.receiverReceived = true;
        smile.save((err,smile) => {
            if (err) {
                throw err;
            }
            if (smile) {
                res.render('smile/showSmile',{
                    title: 'NewSmile',
                    smile: smile
                })
            }
        })
    })
})
// Get method to display Post Form
app.get('/displayPostForm',requireLogin,(req,res) => {
    res.render('post/displayPostForm',{
        title: 'Post'
    });
});
// Create post
app.post('/createPost',requireLogin,(req,res) => {
    let allowComments = Boolean;
    if (req.body.allowComments) {
        allowComments = true;
    }else{
        allowComments = false;
    }
    const newPost = {
        title: req.body.title,
        body: req.body.body,
        status: req.body.status,
        image: `https://online-dating-app.s3.ap-south-1.amazonaws.com/${req.body.image}`,
        postUser: req.user._id,
        allowComments: allowComments,
        date: new Date()
    }
    if (req.body.status === 'public') {
        newPost.icon = 'fa fa-globe';
    }
    if (req.body.status === 'private') {
        newPost.icon = 'fa fa-key';
    }
    if (req.body.status === 'friends') {
        newPost.icon = 'fa fa-group';
    }
    new Post(newPost).save()
    .then(() => {
        if (req.body.status === 'public') {
            res.redirect('/posts');
        }else{
            res.redirect('/profile');
        }
    })
});
// DISPLAY ALL PUBLIC POSTS
app.get('/posts',requireLogin,(req,res) => {
    Post.find({status:'public'})
    .populate('postUser')
    .sort({date:'desc'})
    .then((posts) => {
        res.render('post/posts',{
            title:'Posts',
            posts:posts
        })
    })
})
// DELETE POSTS
app.get('/deletePost/:id',requireLogin,(req,res) => {
    Post.deleteOne({_id:req.params.id})
    .then(() => {
        res.redirect('/profile');
    })
})
// EDIT POST
app.get('/editPost/:id',requireLogin,(req,res) => {
    Post.findById({_id:req.params.id})
    .then((post) => {
        res.render('post/editPost',{
            title:'Editing',
            post:post
        })
    })
})
// SUBMIT FORM TO UPDATE POST
app.post('/editPost/:id',requireLogin,(req,res) => {
    Post.findByIdAndUpdate({_id:req.params.id})
    .then((post) => {
        let allowComments = Boolean;
        if (req.body.allowComments) {
            allowComments = true;
        }else{
            allowComments = false;
        }
        post.title = req.body.title;
        post.body = req.body.body;
        post.status = req.body.status;
        post.allowComments = allowComments;
        post.image = `https://online-dating-app.s3.ap-south-1.amazonaws.com/${req.body.image}`;
        post.date = new Date()

        if (req.body.status === 'public') {
            post.icon = 'fa fa-globe';
        }
        if (req.body.status === 'private') {
            post.icon = 'fa fa-key';
        }
        if (req.body.status === 'friends') {
            post.icon = 'fa fa-group';
        }
        post.save()
        .then(() => {
            res.redirect('/profile');
        })
    })
})
// ADD LIKE FOR EACH POST
app.get('/likePost/:id',requireLogin,(req,res) => {
    Post.findById({_id:req.params.id})
    .then((post) => {
        const newLike = {
            likeUser: req.user._id,
            date: new Date()
        }
        post.likes.push(newLike)
        post.save((err,post) => {
            if (err) {
                throw err;
            }
            if (post) {
                res.redirect(`/fullPost/${post._id}`);
            }
        })
    })
})
app.get('/fullpost/:id',requireLogin,(req,res) => {
    Post.findById({_id:req.params.id})
    .populate('postUser')
    .populate('likes.likeUser')
    .populate('comments.commentUser')
    .sort({date:'desc'})
    .then((post) => {
        res.render('post/fullpost',{
            title:'Full Post',
            post:post
        })
    })
})
// Submit form to leave comment
app.post('/leaveComment/:id',requireLogin,(req,res) => {
    Post.findById({_id:req.params.id})
    .then((post) => {
        const newComment = {
            commentUser: req.user._id,
            commentBody: req.body.commentBody,
            date: new Date()
        }
        post.comments.push(newComment)
        post.save((err,post) => {
            if (err) {
                throw err;
            }
            if (post) {
                res.redirect(`/fullpost/${post._id}`);
            }
        })
    })
})
// Start Friend Request Process
app.get('/sendFriendRequest/:id', requireLogin,(req,res) => {
    User.findOne({_id:req.params.id})
    .then((user) => {
        let newFriendRequest = {
            friend: req.user._id
        }
        user.friends.push(newFriendRequest)
        user.save((err,user) => {
            if (err) {
                throw err;
            }
            if (user) {
                res.render('friends/askFriendRequest', {
                    title: 'Request',
                    newFriend: user
                })
            }
        })
    })
})
app.get('/showFriendRequest/:id',requireLogin,(req,res) => {
    User.findOne({_id:req.params.id})
    .then((userRequest) => {
        res.render('friends/showFriendRequest',{
            title:'Request',
            newFriend: userRequest
        })
    })
})
// Accept friend request
app.get('/acceptFriend/:id',requireLogin,(req,res) => {
    User.findById({_id:req.user._id})
    .populate('friends.friend')
    .then((user) => {
        user.friends.filter((friend) => {
            if (friend._id = req.params.id) {
                friend.isFriend = true;
                user.save()
                .then(() => {
                    User.findById({_id:req.user._id})
                    .populate('friends.friend')
                    .sort({date:'desc'})
                    .then((user) => {
                        res.render('friends/friendAccepted',{
                            title: 'Friends',
                            userInfo:user
                        })
                    })
                })
            }else{
                res.render('friends/404',{
                    title: 'Not Found'
                })
            }
        })
    }).catch((err) => {
        console.log(err);
    })
})
app.get('/friends',requireLogin, (req,res) => {
    User.findById({_id:req.user._id})
    .populate('friends.friend')
    .then((user) => {
        res.render('friends/friends',{
            title:'Friends',
            userFriends:user
        })
    })
})
// Reject Friend Request
app.get('/rejectFriend/:id',requireLogin,(req,res) => {
    User.findById({_id:req.user._id})
    .populate('friends.friend')
    .then((user) => {
        user.friends.filter((friend) => {
            if (friend._id = req.params.id) {
                user.friends.pop(friend)
                user.save()
                .then(() => {
                    User.findOne({_id:req.params.id})
                    .then((friend) => {
                        res.render('friends/rejectFriendRequest',{
                            title: 'Rejected',
                            friend:friend
                        })
                    })
                })
            }else{
                res.render('friends/404',{
                    title:'Not Found'
                })
            }
        })
    })
})
app.get('/logout',(req,res) => {
    User.findById({_id:req.user._id})
    .then((user) => {
        user.online = false;
        user.save((err,user) => {
            if (err) {
                throw err;
            }
            if (user) {
                req.logout();
                res.redirect('/');
            }
        });
    });
});

app.post('/contactUs',(req,res) => {
    console.log(req.body);
    const newMessage = {
        fullname: req.body.fullname,
        email: req.body.email,
        message: req.body.message,
        date: new Date()
    }
    new Message(newMessage).save((err,message) => {
        if (err) {
            throw err;
        }
        else{
            Message.find({}).then((messages) => {
                if (messages) {
                    res.render('newmessage', {
                        title: 'sent',
                        messages:messages
                    });
                }
                else{
                    res.render('noMessage',{
                        title: 'Not Found'
                    });
                }
            });
        }
    });
});

app.listen(port,() => {
    console.log('Server is running on port ' + port);
});